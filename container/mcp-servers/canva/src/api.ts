import * as fs from 'node:fs';
import * as path from 'node:path';

const STUDIO_URL = (process.env.GHOSTY_STUDIO_URL || 'https://ghosty.studio').replace(/\/$/, '');
const STUDIO_TOKEN = process.env.NANOCLAW_ADMIN_TOKEN || '';
const AGENT_GROUP_ID = process.env.NANOCLAW_GROUP_FOLDER || '';
const USER_ID = process.env.NANOCLAW_CHAT_JID || '';

const CANVA_API = 'https://api.canva.com/rest/v1';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
};

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
  const r = await fetch(`${STUDIO_URL}/api/canva/permit`, {
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
 * Resuelve un access_token vigente para llamar a Canva. Maneja:
 *  - cuotas (429 → mensaje al user con retry_after)
 *  - falta de OAuth (404 → instruye a ejecutar canva_connect)
 *  - errores de red / refresh
 */
export async function getCanvaToken(endpoint: string, cost = 1): Promise<{ token: string } | ToolResult> {
  const cfg = configError();
  if (cfg) return cfg;

  const res = await requestPermit(endpoint, cost);

  if ('allowed' in res && res.allowed === true) {
    return { token: res.access_token };
  }
  if ('error' in res && res.error === 'needs_oauth') {
    return err(
      'El usuario aún no conectó su Canva.',
      'Llama primero a canva_connect para obtener un link de autorización y mándalo al usuario.',
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

  const r = await fetch(`${STUDIO_URL}/api/oauth/canva/link`, {
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
      'Manda este link al usuario. Cuando autorice en Canva, ya podrás llamar a las demás tools.',
  });
}

export async function disconnectCanva(): Promise<ToolResult> {
  const cfg = configError();
  if (cfg) return cfg;

  const r = await fetch(`${STUDIO_URL}/api/oauth/canva/disconnect`, {
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
        ? 'Conexión Canva desconectada y token revocado en Canva.'
        : 'Conexión local borrada. Si quieres revocar también del lado de Canva manualmente: canva.com → Settings → Connected apps.',
  });
}

export async function callCanva(
  endpoint: string,
  init: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; path: string; body?: unknown; cost?: number },
): Promise<ToolResult> {
  const tokenResult = await getCanvaToken(endpoint, init.cost ?? 1);
  if ('content' in tokenResult) return tokenResult;
  const token = tokenResult.token;

  const url = `${CANVA_API}${init.path}`;
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
  const text = await r.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!r.ok) {
    return err(`Canva ${r.status}: ${typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)}`);
  }
  return ok(data);
}

async function callCanvaBinary(
  endpoint: string,
  init: { path: string; metadataHeader: string; metadata: Record<string, unknown>; body: Buffer; cost: number },
): Promise<ToolResult> {
  const tokenResult = await getCanvaToken(endpoint, init.cost);
  if ('content' in tokenResult) return tokenResult;
  const token = tokenResult.token;

  const r = await fetch(`${CANVA_API}${init.path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
      [init.metadataHeader]: JSON.stringify(init.metadata),
      accept: 'application/json',
    },
    body: new Uint8Array(init.body),
  });
  const text = await r.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!r.ok) {
    return err(`Canva ${r.status}: ${typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)}`);
  }
  return ok(data);
}

function b64(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64');
}

export async function uploadAsset(filePath: string, name?: string): Promise<ToolResult> {
  if (!fs.existsSync(filePath)) {
    return err(`Archivo no existe: ${filePath}`);
  }
  const buffer = fs.readFileSync(filePath);
  const finalName = name || path.basename(filePath);
  return callCanvaBinary('upload_asset', {
    path: '/asset-uploads',
    metadataHeader: 'Asset-Upload-Metadata',
    metadata: { name_base64: b64(finalName) },
    body: buffer,
    cost: 2,
  });
}

export async function importDesign(filePath: string, title?: string, mimeType?: string): Promise<ToolResult> {
  if (!fs.existsSync(filePath)) {
    return err(`Archivo no existe: ${filePath}`);
  }
  const buffer = fs.readFileSync(filePath);
  const finalTitle = (title || path.basename(filePath, path.extname(filePath))).slice(0, 50);
  const ext = path.extname(filePath).toLowerCase();
  const finalMime = mimeType || MIME_BY_EXT[ext];
  if (!finalMime) {
    return err(`No pude inferir mime_type de "${ext}". Pásalo explícito en mime_type.`);
  }
  return callCanvaBinary('import_design', {
    path: '/imports',
    metadataHeader: 'Import-Metadata',
    metadata: { title_base64: b64(finalTitle), mime_type: finalMime },
    body: buffer,
    cost: 5,
  });
}
