const BASE_URL = (process.env.SKYDROPX_BASE_URL || 'https://pro.skydropx.com').replace(/\/$/, '');
const CLIENT_ID = process.env.SKYDROPX_CLIENT_ID || '';
const CLIENT_SECRET = process.env.SKYDROPX_CLIENT_SECRET || '';

export type SkyResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; title?: string; detail?: string; hint?: string };

interface CachedToken {
  token: string;
  expiresAt: number;
}

let cached: CachedToken | null = null;

function mapHint(status: number): string | undefined {
  if (status === 401) return 'Token rejected — check SKYDROPX_CLIENT_ID/SECRET, or that sandbox creds are not pointed at prod (and viceversa)';
  if (status === 403) return 'Forbidden — account may lack permission for this operation or environment';
  if (status === 404) return 'Resource not found — verify shipment_id, tracking_number, or carrier_name spelling';
  if (status === 422) return 'Validation error — check addresses (postal_code, country) and parcel dimensions/weight';
  if (status === 429) return 'Rate limit hit (Skydropx allows 2 req/s)';
  return undefined;
}

async function fetchToken(): Promise<{ ok: true; token: string; expiresAt: number } | { ok: false; status: number; detail: string }> {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return { ok: false, status: 0, detail: 'SKYDROPX_CLIENT_ID or SKYDROPX_CLIENT_SECRET not set' };
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/v1/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
  } catch (err) {
    return { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err) };
  }
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, detail: text.slice(0, 500) };
  }
  let payload: { access_token?: string; expires_in?: number };
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, status: res.status, detail: `Non-JSON token response: ${text.slice(0, 200)}` };
  }
  if (!payload.access_token) {
    return { ok: false, status: res.status, detail: `Token response missing access_token: ${text.slice(0, 200)}` };
  }
  // Default to 2h if expires_in is missing; refresh 60s before expiry
  const ttlSec = typeof payload.expires_in === 'number' ? payload.expires_in : 7200;
  return { ok: true, token: payload.access_token, expiresAt: Date.now() + (ttlSec - 60) * 1000 };
}

async function getToken(forceRefresh = false): Promise<{ ok: true; token: string } | { ok: false; status: number; detail: string }> {
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return { ok: true, token: cached.token };
  }
  const result = await fetchToken();
  if (!result.ok) return result;
  cached = { token: result.token, expiresAt: result.expiresAt };
  return { ok: true, token: result.token };
}

async function request<T>(
  method: 'GET' | 'POST',
  pathname: string,
  body?: unknown,
  attempt = 0,
): Promise<SkyResult<T>> {
  const tokenResult = await getToken(attempt === 1);
  if (!tokenResult.ok) {
    return { ok: false, status: tokenResult.status, title: 'Auth error', detail: tokenResult.detail, hint: mapHint(tokenResult.status) };
  }

  const url = `${BASE_URL}${pathname}`;
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${tokenResult.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (attempt < 1) return request<T>(method, pathname, body, attempt + 1);
    return { ok: false, status: 0, title: 'Network error', detail: err instanceof Error ? err.message : String(err) };
  }

  // 401 → token may have been revoked or rotated server-side; try once with a fresh token
  if (res.status === 401 && attempt < 1) {
    cached = null;
    return request<T>(method, pathname, body, attempt + 1);
  }

  if (res.status === 429 && attempt < 1) {
    const retryAfter = parseInt(res.headers.get('retry-after') || '1', 10);
    await new Promise((r) => setTimeout(r, Math.max(retryAfter * 1000, 600)));
    return request<T>(method, pathname, body, attempt + 1);
  }

  if (res.status >= 500 && attempt < 1) {
    await new Promise((r) => setTimeout(r, 600));
    return request<T>(method, pathname, body, attempt + 1);
  }

  const text = await res.text();
  const data = text ? safeJson(text) : null;

  if (!res.ok) {
    const err = (data as { title?: string; message?: string; error?: string; detail?: string }) || {};
    return {
      ok: false,
      status: res.status,
      title: err.title || err.error || res.statusText,
      detail: err.detail || err.message || text.slice(0, 500),
      hint: mapHint(res.status),
    };
  }

  if (res.status === 204) return { ok: true, data: null as unknown as T };
  return { ok: true, data: data as T };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const skydropx = {
  get: <T>(pathname: string) => request<T>('GET', pathname),
  post: <T>(pathname: string, body: unknown) => request<T>('POST', pathname, body),
};

export function toToolResult<T>(result: SkyResult<T>) {
  if (result.ok) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
  }
  const err = { status: result.status, title: result.title, detail: result.detail, hint: result.hint };
  return { content: [{ type: 'text' as const, text: JSON.stringify(err, null, 2) }], isError: true };
}
