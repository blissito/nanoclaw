/**
 * Supabase (PostgREST) MCP Server — stdio transport.
 *
 * Gives agents scoped, bounded-output access to a Supabase project so they never
 * need to `curl` the REST API directly. Raw curls against `/rest/v1/` return the
 * full ~50KB OpenAPI schema and unbounded row dumps, which refill the context
 * window and trip the SDK's autocompact-thrash kill. Every tool here caps its
 * output (see capText) and list_tables returns only names, never the schema.
 *
 * Env:
 *   SUPABASE_URL                — https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY   — service_role JWT (bypasses RLS; full access)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { sb, toToolResult, capText } from './api.js';

const server = new McpServer({ name: 'supabase', version: '1.0.0' });

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

// ─── Schema introspection (cached; consumes the big swagger server-side) ──────

type Swagger = {
  definitions?: Record<string, { properties?: Record<string, { type?: string; format?: string }> }>;
  paths?: Record<string, unknown>;
};

let schemaCache: Swagger | null = null;

async function getSchema(): Promise<Swagger | { error: string }> {
  if (schemaCache) return schemaCache;
  const res = await sb.get<Swagger>('/');
  if (!res.ok) return { error: `${res.status}: ${res.detail}` };
  schemaCache = res.data || {};
  return schemaCache;
}

server.tool(
  'supabase_list_tables',
  'Lista los nombres de tablas/vistas y funciones RPC disponibles en el proyecto Supabase. Devuelve SOLO nombres (no el schema completo). Úsalo para descubrir qué hay antes de consultar — nunca hagas curl al endpoint REST.',
  {},
  async () => {
    const schema = await getSchema();
    if ('error' in schema) {
      return { content: [{ type: 'text', text: schema.error }], isError: true };
    }
    const tables = Object.keys(schema.definitions || {}).sort();
    const rpcs = Object.keys(schema.paths || {})
      .filter((p) => p.startsWith('/rpc/'))
      .map((p) => p.slice('/rpc/'.length))
      .sort();
    return {
      content: [{ type: 'text', text: capText(JSON.stringify({ tables, rpcs }, null, 2)) }],
    };
  },
);

server.tool(
  'supabase_describe_table',
  'Devuelve las columnas y sus tipos de una tabla (sin datos). Úsalo para saber qué columnas pedir en `select` antes de consultar.',
  { table: z.string().describe('Nombre exacto de la tabla') },
  async ({ table }) => {
    const schema = await getSchema();
    if ('error' in schema) {
      return { content: [{ type: 'text', text: schema.error }], isError: true };
    }
    const def = schema.definitions?.[table];
    if (!def) {
      return {
        content: [
          { type: 'text', text: `Tabla "${table}" no encontrada. Usa supabase_list_tables.` },
        ],
        isError: true,
      };
    }
    const columns: Record<string, string> = {};
    for (const [col, meta] of Object.entries(def.properties || {})) {
      columns[col] = meta.format || meta.type || 'unknown';
    }
    return { content: [{ type: 'text', text: capText(JSON.stringify({ table, columns }, null, 2)) }] };
  },
);

// ─── Read ─────────────────────────────────────────────────────────────────

server.tool(
  'supabase_query',
  'Consulta filas de una tabla/vista (PostgREST GET). SIEMPRE acota: pasa `select` con columnas específicas y un `limit` chico. La respuesta está limitada en tamaño; si se trunca, reduce columnas/limit en vez de reintentar igual.',
  {
    table: z.string().describe('Nombre de la tabla/vista'),
    select: z
      .string()
      .optional()
      .describe('Columnas PostgREST, ej. "id,role,status,created_at". Default "*" (evítalo en tablas anchas).'),
    filter: z
      .string()
      .optional()
      .describe('Condiciones PostgREST crudas unidas por &, ej. "status=eq.new&role=eq.founder". Sin el "?" inicial.'),
    order: z.string().optional().describe('Orden PostgREST, ej. "created_at.desc"'),
    limit: z
      .number()
      .int()
      .optional()
      .describe(`Máx filas (default ${DEFAULT_LIMIT}, tope ${MAX_LIMIT})`),
  },
  async ({ table, select, filter, order, limit }) => {
    const lim = Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const parts = [`select=${select || '*'}`];
    if (filter) parts.push(filter.replace(/^[?&]+/, ''));
    if (order) parts.push(`order=${order}`);
    parts.push(`limit=${lim}`);
    return toToolResult(await sb.get(`/${table}?${parts.join('&')}`));
  },
);

// ─── Write (service_role: bypasses RLS — handle with care) ───────────────────

server.tool(
  'supabase_insert',
  'Inserta una o varias filas en una tabla. Devuelve las filas creadas.',
  {
    table: z.string(),
    rows: z
      .union([z.record(z.string(), z.any()), z.array(z.record(z.string(), z.any()))])
      .describe('Objeto fila o arreglo de filas'),
  },
  async ({ table, rows }) => {
    return toToolResult(await sb.post(`/${table}`, rows, 'return=representation'));
  },
);

server.tool(
  'supabase_update',
  'Actualiza filas que cumplan el filtro. `filter` es OBLIGATORIO (se rechaza vacío para no tocar toda la tabla).',
  {
    table: z.string(),
    filter: z
      .string()
      .describe('Condiciones PostgREST, ej. "id=eq.42" o "status=eq.new". OBLIGATORIO.'),
    values: z.record(z.string(), z.any()).describe('Columnas a actualizar'),
  },
  async ({ table, filter, values }) => {
    const f = (filter || '').replace(/^[?&]+/, '').trim();
    if (!f) {
      return {
        content: [
          { type: 'text', text: 'Rechazado: `filter` vacío actualizaría toda la tabla. Especifica condiciones.' },
        ],
        isError: true,
      };
    }
    return toToolResult(await sb.patch(`/${table}?${f}`, values, 'return=representation'));
  },
);

server.tool(
  'supabase_delete',
  'Borra filas que cumplan el filtro. `filter` es OBLIGATORIO (se rechaza vacío para no vaciar la tabla).',
  {
    table: z.string(),
    filter: z.string().describe('Condiciones PostgREST, ej. "id=eq.42". OBLIGATORIO.'),
  },
  async ({ table, filter }) => {
    const f = (filter || '').replace(/^[?&]+/, '').trim();
    if (!f) {
      return {
        content: [
          { type: 'text', text: 'Rechazado: `filter` vacío vaciaría la tabla. Especifica condiciones.' },
        ],
        isError: true,
      };
    }
    return toToolResult(await sb.delete(`/${table}?${f}`, 'return=representation'));
  },
);

server.tool(
  'supabase_rpc',
  'Llama una función RPC de Postgres (POST /rpc/{fn}). Pasa los argumentos como objeto. La respuesta está limitada en tamaño.',
  {
    fn: z.string().describe('Nombre de la función RPC'),
    args: z.record(z.string(), z.any()).optional().describe('Argumentos como objeto JSON'),
  },
  async ({ fn, args }) => {
    return toToolResult(await sb.post(`/rpc/${fn}`, args || {}));
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
