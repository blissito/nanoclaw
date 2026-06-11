/**
 * Supabase PostgREST client for the MCP server.
 *
 * Env:
 *   SUPABASE_URL                — e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY   — service_role JWT (bypasses RLS, full DB access)
 *
 * Every tool result passes through capText() so a single query can never dump a
 * huge payload into the agent's context window. The whole reason this server
 * exists: agents used to `curl /rest/v1/` (the full ~50KB OpenAPI schema) and
 * page through unbounded rows, refilling the context within a few turns and
 * tripping the SDK's autocompact-thrash kill. Bounded output kills that at the
 * source.
 */

const BASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

/** Hard ceiling on serialized tool output (chars). ~8KB ≈ ~2k tokens. */
export const MAX_RESULT_CHARS = 8000;

export type SbResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; detail: string; hint?: string };

function mapHint(status: number): string | undefined {
  if (status === 401) return 'Bad apikey/JWT — check SUPABASE_SERVICE_ROLE_KEY';
  if (status === 403)
    return 'Forbidden (RLS / role). service_role bypasses RLS, so a 403 here usually means a missing grant or a restricted RPC';
  if (status === 404) return 'Table or RPC not found — check the name with supabase_list_tables';
  if (status === 409) return 'Conflict — likely a unique/foreign-key constraint';
  return undefined;
}

async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  pathname: string,
  opts: { body?: unknown; prefer?: string } = {},
  attempt = 0,
): Promise<SbResult<T>> {
  if (!BASE_URL || !KEY) {
    return {
      ok: false,
      status: 0,
      detail: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set',
    };
  }

  const url = `${BASE_URL}/rest/v1${pathname}`;
  const headers: Record<string, string> = {
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    Accept: 'application/json',
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.prefer) headers['Prefer'] = opts.prefer;

  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (attempt < 1) return request<T>(method, pathname, opts, attempt + 1);
    return {
      ok: false,
      status: 0,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (res.status >= 500 && attempt < 1) {
    await new Promise((r) => setTimeout(r, 500));
    return request<T>(method, pathname, opts, attempt + 1);
  }

  const text = await res.text();
  const data = text ? safeJson(text) : null;

  if (!res.ok) {
    const err = (data as { message?: string; hint?: string; details?: string }) || {};
    return {
      ok: false,
      status: res.status,
      detail: err.message || err.details || text.slice(0, 300),
      hint: err.hint || mapHint(res.status),
    };
  }

  return { ok: true, data: (data as T) ?? (null as unknown as T) };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const sb = {
  get: <T>(pathname: string) => request<T>('GET', pathname),
  post: <T>(pathname: string, body: unknown, prefer?: string) =>
    request<T>('POST', pathname, { body, prefer }),
  patch: <T>(pathname: string, body: unknown, prefer?: string) =>
    request<T>('PATCH', pathname, { body, prefer }),
  delete: <T>(pathname: string, prefer?: string) =>
    request<T>('DELETE', pathname, { prefer }),
};

/** Truncate any string to the result ceiling with an explicit, actionable note. */
export function capText(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return (
    text.slice(0, MAX_RESULT_CHARS) +
    `\n\n…[truncado: respuesta de ${text.length} chars excede el límite de ${MAX_RESULT_CHARS}. ` +
    `Acota con un \`select\` de columnas específicas y/o baja \`limit\`. NO intentes traer todo.]`
  );
}

export function toToolResult<T>(result: SbResult<T>) {
  if (result.ok) {
    return {
      content: [
        { type: 'text' as const, text: capText(JSON.stringify(result.data, null, 2)) },
      ],
    };
  }
  const err = { status: result.status, detail: result.detail, hint: result.hint };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(err, null, 2) }],
    isError: true,
  };
}
