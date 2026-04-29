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
import { callCanva, getConnectLink, uploadAsset, importDesign, disconnectCanva } from './api.js';

const server = new McpServer({ name: 'canva', version: '1.0.0' });

server.tool(
  'canva_connect',
  'Genera un link mágico para que el usuario conecte su cuenta de Canva. Ejecuta esta tool PRIMERO si el usuario aún no autorizó, o si otra tool devuelve "needs_oauth". Manda el link al usuario por WhatsApp; el link expira en 10 minutos.',
  {},
  async () => getConnectLink(),
);

server.tool(
  'canva_disconnect',
  'Desconecta la cuenta de Canva del usuario actual: borra los tokens guardados y revoca el refresh_token en Canva (best-effort). Úsala cuando el user pida explícitamente "desconecta canva", "desvincula", "olvida mi canva", "revoca acceso". Después de esto, la próxima tool que necesite Canva pedirá `canva_connect` de nuevo.',
  {},
  async () => disconnectCanva(),
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
  'Crea un diseño EN BLANCO (sin contenido) con un design_type estándar. ⚠️ NO permite inyectar texto ni imágenes — solo abre un canvas vacío para que el user lo edite a mano en Canva. Si el user pide algo CON CONTENIDO ("hazme una propuesta para X", "presentación con estos datos"), usa `canva_create_design_autofill` (Brand Template + datos) o genera un PPTX/PDF y súbelo con `canva_import_design`. Costo: 2.',
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

server.tool(
  'canva_list_brand_templates',
  'Lista las Brand Templates del usuario (plantillas con campos rellenables vía autofill). USA ESTA TOOL antes de `canva_create_design_autofill` para encontrar la plantilla correcta. Devuelve {id, title, thumbnail}. Costo: 1.',
  {
    query: z.string().optional().describe('Filtrar plantillas por título'),
    continuation: z.string().optional().describe('Token de paginación'),
  },
  async ({ query, continuation }) => {
    const qs = new URLSearchParams();
    if (query) qs.set('query', query);
    if (continuation) qs.set('continuation', continuation);
    const path = `/brand-templates${qs.toString() ? `?${qs}` : ''}`;
    return callCanva('list_brand_templates', { method: 'GET', path, cost: 1 });
  },
);

server.tool(
  'canva_get_brand_template_dataset',
  'Obtiene el dataset (campos rellenables) de una Brand Template específica. ANTES de `canva_create_design_autofill`, llama esto para saber qué fields existen y de qué tipo (text/image/chart). Devuelve `{ dataset: { field_name: { type } } }`. Costo: 1.',
  {
    brand_template_id: z.string().describe('ID de la Brand Template'),
  },
  async ({ brand_template_id }) => {
    return callCanva('get_brand_template_dataset', {
      method: 'GET',
      path: `/brand-templates/${encodeURIComponent(brand_template_id)}/dataset`,
      cost: 1,
    });
  },
);

server.tool(
  'canva_create_design_autofill',
  'Crea un diseño nuevo a partir de una Brand Template, rellenando sus campos con datos. ESTA es la tool para "propuesta para X con estos datos" o "post de Instagram con este texto". Requiere Canva Enterprise en la cuenta del user. Devuelve job_id; usa `canva_get_autofill_status` para obtener el design final. Costo: 5.',
  {
    brand_template_id: z.string().describe('ID de la Brand Template (vía canva_list_brand_templates)'),
    title: z.string().optional().describe('Título del diseño resultante (1-255 chars)'),
    data: z
      .record(z.string(), z.any())
      .describe(
        'Mapa de field_key → value. Para text: { type: "text", text: "..." }. Para image: { type: "image", asset_id: "..." } (sube primero con canva_upload_asset). Para chart: { type: "chart", chart_data: { column_configs, rows } }. Los keys deben coincidir con el dataset de la template (canva_get_brand_template_dataset).',
      ),
  },
  async ({ brand_template_id, title, data }) => {
    return callCanva('create_design_autofill', {
      method: 'POST',
      path: '/autofills',
      body: { brand_template_id, ...(title ? { title } : {}), data },
      cost: 5,
    });
  },
);

server.tool(
  'canva_get_autofill_status',
  'Verifica el status de un autofill job iniciado con `canva_create_design_autofill`. Cuando `status === "success"`, devuelve el `result.design` (id, urls, thumbnail) listo para exportar o mandar al user. Espera 5-10s entre llamadas. Costo: 1.',
  {
    job_id: z.string().describe('ID del autofill job'),
  },
  async ({ job_id }) => {
    return callCanva('get_autofill_status', {
      method: 'GET',
      path: `/autofills/${encodeURIComponent(job_id)}`,
      cost: 1,
    });
  },
);

server.tool(
  'canva_upload_asset',
  'Sube una imagen/video al asset library del user, devuelve `asset_id` para usar en `canva_create_design_autofill` (campos tipo image). Acepta path local del container. Formatos: jpg, png, webp, mp4. Costo: 2.',
  {
    file_path: z.string().describe('Path absoluto al archivo en el container (ej. /workspace/group/attachments/foo.png)'),
    name: z.string().optional().describe('Nombre del asset (default: filename)'),
  },
  async ({ file_path, name }) => uploadAsset(file_path, name),
);

server.tool(
  'canva_import_design',
  'Importa un archivo (PPTX, DOCX, PDF, etc.) creado en otra app y lo convierte en diseño Canva editable. Útil cuando generas un PPTX con pptx-gen y quieres convertirlo a Canva. Devuelve job_id; usa `canva_get_import_status` para obtener el design. Costo: 5.',
  {
    file_path: z.string().describe('Path absoluto al archivo en el container'),
    title: z.string().optional().describe('Título del diseño resultante'),
    mime_type: z
      .string()
      .optional()
      .describe(
        'MIME type del archivo (auto-detectado por extensión si se omite). Ej. application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ),
  },
  async ({ file_path, title, mime_type }) => importDesign(file_path, title, mime_type),
);

server.tool(
  'canva_get_import_status',
  'Verifica el status de un import iniciado con `canva_import_design`. Cuando `status === "success"`, devuelve los `designs[]` creados. Espera 5-10s entre llamadas. Costo: 1.',
  {
    job_id: z.string().describe('ID del import job'),
  },
  async ({ job_id }) => {
    return callCanva('get_import_status', {
      method: 'GET',
      path: `/imports/${encodeURIComponent(job_id)}`,
      cost: 1,
    });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
