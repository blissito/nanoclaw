/**
 * Canva Connect MCP Server — stdio transport.
 *
 * OAuth multi-user vía ghosty.studio:
 *   - canva_connect → genera link, el user autoriza en Canva
 *   - el resto de tools llaman a /api/canva/permit antes (cuotas + token)
 *
 * Env:
 *   GHOSTY_STUDIO_URL    — default https://ghosty.studio
 *   NANOCLAW_ADMIN_TOKEN — Bearer del Deployment (mismo token que admin-api / usage-reporter)
 *   NANOCLAW_GROUP_FOLDER — agent_group_id
 *   NANOCLAW_CHAT_JID     — user_id (jid del chat)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { callCanva, getConnectLink } from './api.js';

const server = new McpServer({ name: 'canva', version: '1.0.0' });

server.tool(
  'canva_connect',
  'Genera un link mágico para que el usuario conecte su cuenta de Canva. Ejecuta esta tool PRIMERO si el usuario aún no autorizó, o si otra tool devuelve "needs_oauth". Manda el link al usuario por WhatsApp; el link expira en 10 minutos.',
  {},
  async () => getConnectLink(),
);

server.tool(
  'canva_list_designs',
  'Lista los diseños del usuario en Canva (ordenados por última modificación, paginados). Costo de cuota: 1.',
  {
    query: z.string().optional().describe('Filtrar por título (búsqueda libre)'),
    continuation: z
      .string()
      .optional()
      .describe('Token de paginación devuelto en una llamada previa para traer la siguiente página'),
    ownership: z
      .enum(['owned', 'shared', 'any'])
      .optional()
      .describe('owned = solo diseños propios; shared = compartidos conmigo; any = ambos'),
  },
  async ({ query, continuation, ownership }) => {
    const qs = new URLSearchParams();
    if (query) qs.set('query', query);
    if (continuation) qs.set('continuation', continuation);
    if (ownership) qs.set('ownership', ownership);
    const path = `/designs${qs.toString() ? `?${qs}` : ''}`;
    return callCanva('list_designs', { method: 'GET', path, cost: 1 });
  },
);

server.tool(
  'canva_get_design',
  'Obtiene metadatos de un diseño específico (URL de edición, thumbnail, fechas, owner). Costo: 1.',
  {
    design_id: z.string().describe('ID del diseño en Canva'),
  },
  async ({ design_id }) => {
    return callCanva('get_design', { method: 'GET', path: `/designs/${encodeURIComponent(design_id)}`, cost: 1 });
  },
);

server.tool(
  'canva_create_design',
  'Crea un diseño nuevo en blanco con un design_type estándar (ej. presentation, doc, instagram_post). Costo: 2.',
  {
    design_type: z
      .string()
      .describe(
        'Tipo de diseño Canva, ej. "presentation", "doc", "instagram_post", "youtube_thumbnail". Lista completa: https://www.canva.dev/docs/connect/api-reference/designs/create-design/',
      ),
    title: z.string().optional().describe('Título inicial del diseño (opcional)'),
  },
  async ({ design_type, title }) => {
    return callCanva('create_design', {
      method: 'POST',
      path: '/designs',
      body: {
        design_type: { type: 'preset', name: design_type },
        ...(title ? { title } : {}),
      },
      cost: 2,
    });
  },
);

server.tool(
  'canva_export_design',
  'Inicia la exportación de un diseño a PDF/PNG/JPG. Devuelve un job_id; usa canva_get_export_status para verificar. Costo: 10 (los exports son los más pesados).',
  {
    design_id: z.string().describe('ID del diseño a exportar'),
    format: z.enum(['pdf', 'png', 'jpg']).describe('Formato de salida'),
    pages: z
      .array(z.number().int().min(1))
      .optional()
      .describe('Lista de páginas a exportar (1-indexed). Omitir = todas las páginas.'),
    quality: z
      .enum(['standard', 'pro'])
      .optional()
      .describe('Solo para PDF: standard (default) o pro (alta calidad).'),
  },
  async ({ design_id, format, pages, quality }) => {
    const formatBlock: Record<string, unknown> = { type: format };
    if (pages) formatBlock.pages = pages;
    if (format === 'pdf' && quality) formatBlock.export_quality = quality;
    return callCanva('export_pdf', {
      method: 'POST',
      path: '/exports',
      body: { design_id, format: formatBlock },
      cost: 10,
    });
  },
);

server.tool(
  'canva_get_export_status',
  'Verifica el status de un export iniciado con canva_export_design. Devuelve URLs de descarga cuando status=success. Costo: 1.',
  {
    export_id: z.string().describe('ID del export job'),
  },
  async ({ export_id }) => {
    return callCanva('get_export_status', {
      method: 'GET',
      path: `/exports/${encodeURIComponent(export_id)}`,
      cost: 1,
    });
  },
);

server.tool(
  'canva_get_user_profile',
  'Obtiene el perfil del usuario conectado en Canva (display name, user_id). Útil para confirmar qué cuenta está vinculada. Costo: 1.',
  {},
  async () => callCanva('get_user_profile', { method: 'GET', path: '/users/me/profile', cost: 1 }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
