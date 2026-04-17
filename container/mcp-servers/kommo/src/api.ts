const BASE_URL = process.env.KOMMO_BASE_URL || '';
const TOKEN = process.env.KOMMO_ACCESS_TOKEN || '';

export type KommoResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; title?: string; detail?: string; hint?: string };

function mapHint(status: number): string | undefined {
  if (status === 401) return 'Token expired or revoked — regenerate long-lived token in Kommo private integration settings';
  if (status === 402) return 'Subscription/plan limit reached';
  if (status === 403) return 'Scope missing — token needs the relevant scope (crm, files, etc.)';
  if (status === 404) return 'Resource not found';
  if (status === 429) return 'Rate limit hit (Kommo allows ~7 req/s per account)';
  return undefined;
}

async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  pathname: string,
  body?: unknown,
  attempt = 0,
): Promise<KommoResult<T>> {
  if (!BASE_URL || !TOKEN) {
    return { ok: false, status: 0, title: 'Config error', detail: 'KOMMO_BASE_URL or KOMMO_ACCESS_TOKEN not set' };
  }

  const url = `${BASE_URL.replace(/\/$/, '')}${pathname}`;
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
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

  if (res.status === 429 && attempt < 1) {
    const retryAfter = parseInt(res.headers.get('retry-after') || '1', 10);
    await new Promise((r) => setTimeout(r, Math.max(retryAfter, 1) * 1000));
    return request<T>(method, pathname, body, attempt + 1);
  }

  if (res.status >= 500 && attempt < 1) {
    await new Promise((r) => setTimeout(r, 500));
    return request<T>(method, pathname, body, attempt + 1);
  }

  const text = await res.text();
  const data = text ? safeJson(text) : null;

  if (!res.ok) {
    const err = (data as { title?: string; detail?: string; status?: number }) || {};
    return {
      ok: false,
      status: res.status,
      title: err.title || res.statusText,
      detail: err.detail || text.slice(0, 500),
      hint: mapHint(res.status),
    };
  }

  // 204 No Content
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

export const kommo = {
  get: <T>(pathname: string) => request<T>('GET', pathname),
  post: <T>(pathname: string, body: unknown) => request<T>('POST', pathname, body),
  patch: <T>(pathname: string, body: unknown) => request<T>('PATCH', pathname, body),
  delete: <T>(pathname: string) => request<T>('DELETE', pathname),
};

export function toToolResult<T>(result: KommoResult<T>) {
  if (result.ok) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
  }
  const err = { status: result.status, title: result.title, detail: result.detail, hint: result.hint };
  return { content: [{ type: 'text' as const, text: JSON.stringify(err, null, 2) }], isError: true };
}
