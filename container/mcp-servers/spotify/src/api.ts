const STUDIO_URL = (process.env.GHOSTY_STUDIO_URL || 'https://ghosty.studio').replace(/\/$/, '');
const STUDIO_TOKEN = process.env.NANOCLAW_ADMIN_TOKEN || '';
const AGENT_GROUP_ID = process.env.NANOCLAW_GROUP_FOLDER || '';
const USER_ID = process.env.NANOCLAW_CHAT_JID || '';

const SPOTIFY_API = 'https://api.spotify.com/v1';

export type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

function err(detail: unknown, hint?: string): ToolResult {
  const payload = { error: true, detail: detail instanceof Error ? detail.message : String(detail), hint };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
}

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function configError(): ToolResult | null {
  if (!STUDIO_TOKEN) return err('NANOCLAW_ADMIN_TOKEN no está configurado en este container');
  if (!AGENT_GROUP_ID) return err('NANOCLAW_GROUP_FOLDER no está configurado');
  if (!USER_ID) return err('NANOCLAW_CHAT_JID no está configurado');
  return null;
}

type PermitResponse =
  | { allowed: true; access_token: string; expires_at: string; scopes: string; usage_id: string }
  | { error: 'needs_oauth' }
  | { allowed: false; reason: string; retry_after_seconds: number; current_usage: number; limit: number };

async function requestPermit(endpoint: string, cost: number): Promise<PermitResponse | { error: string; detail?: string }> {
  const r = await fetch(`${STUDIO_URL}/api/spotify/permit`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${STUDIO_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      agent_group_id: AGENT_GROUP_ID,
      user_id: USER_ID,
      endpoint,
      cost,
    }),
  });
  const text = await r.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    return { error: 'invalid_permit_response', detail: text.slice(0, 300) };
  }
  if (r.ok) return data as PermitResponse;
  if (r.status === 404 && data?.error === 'needs_oauth') return data;
  if (r.status === 429) return data;
  return { error: `permit_${r.status}`, detail: data?.detail || data?.error || text.slice(0, 300) };
}

/**
 * Resuelve un access_token vigente de Spotify para el user actual. Maneja:
 *  - cuotas (429 → mensaje al user con retry_after)
 *  - falta de OAuth (404 → instruye a ejecutar spotify_connect)
 *  - errores de red / refresh (el refresh lo hace ghosty.studio server-side)
 */
export async function getSpotifyToken(endpoint: string, cost = 1): Promise<{ token: string } | ToolResult> {
  const cfg = configError();
  if (cfg) return cfg;

  const res = await requestPermit(endpoint, cost);

  if ('allowed' in res && res.allowed === true) {
    return { token: res.access_token };
  }
  if ('error' in res && res.error === 'needs_oauth') {
    return err(
      'El usuario aún no conectó su Spotify.',
      'Llama primero a spotify_connect para obtener un link de autorización y mándalo al usuario.',
    );
  }
  if ('allowed' in res && res.allowed === false) {
    return err(
      `Cuota agotada: ${res.reason} (${res.current_usage}/${res.limit}).`,
      `Reintenta en ${Math.ceil(res.retry_after_seconds / 60)} minutos.`,
    );
  }
  return err((res as any).detail || (res as any).error || 'permit_failed');
}

export async function getConnectLink(): Promise<ToolResult> {
  const cfg = configError();
  if (cfg) return cfg;

  const r = await fetch(`${STUDIO_URL}/api/oauth/spotify/link`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${STUDIO_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      agent_group_id: AGENT_GROUP_ID,
      initiating_user_id: USER_ID,
    }),
  });
  const text = await r.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    return err('invalid_link_response', text.slice(0, 300));
  }
  if (!r.ok) return err(data?.error || `link_${r.status}`, data?.detail);
  return ok({
    link: data.link,
    expires_in_seconds: data.expires_in_seconds,
    instructions:
      'Manda este link al usuario. Cuando autorice en Spotify, ya podrás llamar a las demás tools.',
  });
}

export async function disconnectSpotify(): Promise<ToolResult> {
  const cfg = configError();
  if (cfg) return cfg;

  const r = await fetch(`${STUDIO_URL}/api/oauth/spotify/disconnect`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${STUDIO_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      agent_group_id: AGENT_GROUP_ID,
      user_id: USER_ID,
    }),
  });
  const text = await r.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    return err('invalid_disconnect_response', text.slice(0, 300));
  }
  if (!r.ok) return err(data?.error || `disconnect_${r.status}`, data?.detail);

  if (!data.revoked) {
    return ok({
      revoked: false,
      message: 'No había una conexión activa que desconectar.',
    });
  }
  return ok({
    revoked: true,
    remote_revoke: data.remote_revoke,
    message:
      data.remote_revoke === 'ok'
        ? 'Conexión Spotify desconectada y token revocado en Spotify.'
        : 'Conexión local borrada. Si quieres revocar también del lado de Spotify manualmente: spotify.com → Cuenta → Apps.',
  });
}

/**
 * Llama a la Spotify Web API con un token resuelto vía permit.
 * Spotify devuelve 204 (sin body) en varias mutaciones de playback — lo tratamos como éxito.
 */
export async function callSpotify(
  endpoint: string,
  init: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: string; body?: unknown; cost?: number },
): Promise<ToolResult> {
  const tokenResult = await getSpotifyToken(endpoint, init.cost ?? 1);
  if ('content' in tokenResult) return tokenResult;
  const token = tokenResult.token;

  const url = `${SPOTIFY_API}${init.path}`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
  };
  const opts: RequestInit = { method: init.method ?? 'GET', headers };
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(init.body);
  }

  const r = await fetch(url, opts);

  // 204 No Content (play/pause/next/previous/queue success) and 202 Accepted have no body.
  if (r.status === 204 || r.status === 202) {
    return ok({ status: 'ok' });
  }

  const text = await r.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (r.ok) {
    // GET /me/player/currently-playing returns 200 with empty body when nothing is active.
    if (data === null) return ok({ status: 'nothing_playing' });
    return ok(data);
  }

  const reason = data?.error?.reason || data?.error?.message || (typeof data === 'string' ? data : JSON.stringify(data));

  if (r.status === 401) {
    return err(
      'Spotify 401: el access_token expiró y el refresh falló.',
      'Pídele al user que reconecte: llama a spotify_connect.',
    );
  }
  if (r.status === 403) {
    return err(
      `Spotify 403: ${reason}`,
      'El control de reproducción requiere Spotify Premium. Si el user no es Premium, no reintentes.',
    );
  }
  if (r.status === 404 && /NO_ACTIVE_DEVICE/i.test(String(reason))) {
    return err(
      'Spotify 404: no hay un dispositivo activo.',
      'Pídele al user que abra Spotify en algún dispositivo (o usa spotify_devices) y reintenta.',
    );
  }
  return err(`Spotify ${r.status}: ${String(reason).slice(0, 300)}`);
}
