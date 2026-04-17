/**
 * Kommo CRM MCP Server — stdio transport.
 * Tools for reading and writing leads, contacts, notes, tasks, tags, pipelines, users.
 *
 * Env:
 *   KOMMO_BASE_URL      — e.g. https://siiqtec.kommo.com
 *   KOMMO_ACCESS_TOKEN  — long-lived token from a Kommo private integration
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { kommo, toToolResult } from './api.js';

const server = new McpServer({ name: 'kommo', version: '1.0.0' });

// ─── READ ──────────────────────────────────────────────────────────────────

server.tool(
  'list_pipelines',
  'List all lead pipelines and their statuses. Call this first to discover pipeline_id/status_id values needed by create_lead and update_lead.',
  {},
  async () => toToolResult(await kommo.get('/api/v4/leads/pipelines')),
);

server.tool(
  'list_users',
  'List all users in the Kommo account (CRM team members). Use their id as responsible_user_id when creating/updating leads or tasks.',
  {},
  async () => toToolResult(await kommo.get('/api/v4/users?limit=250')),
);

server.tool(
  'find_contact',
  'Search contacts by free-text query (matches name, phone, email, custom fields). Use BEFORE create_contact to avoid duplicates.',
  {
    query: z.string().describe('Search query — a phone number, email, or partial name'),
    limit: z.number().int().min(1).max(50).default(10).describe('Max results (1-50, default 10)'),
  },
  async ({ query, limit }) => {
    const qs = new URLSearchParams({ query, limit: String(limit) });
    return toToolResult(await kommo.get(`/api/v4/contacts?${qs}`));
  },
);

server.tool(
  'get_contact',
  'Get full contact details including the leads associated with this contact.',
  { contact_id: z.number().int().describe('Kommo contact id') },
  async ({ contact_id }) => toToolResult(await kommo.get(`/api/v4/contacts/${contact_id}?with=leads`)),
);

server.tool(
  'list_leads',
  'List leads with optional filters. Returns the most recently updated first.',
  {
    query: z.string().optional().describe('Free-text search'),
    pipeline_id: z.number().int().optional().describe('Filter by pipeline (required if status_id is set)'),
    status_id: z.number().int().optional().describe('Filter by status within the pipeline (requires pipeline_id)'),
    responsible_user_id: z.number().int().optional().describe('Filter by responsible user'),
    limit: z.number().int().min(1).max(250).default(20).describe('Max results'),
    page: z.number().int().min(1).default(1).describe('Page number'),
  },
  async ({ query, pipeline_id, status_id, responsible_user_id, limit, page }) => {
    const qs = new URLSearchParams();
    if (query) qs.set('query', query);
    qs.set('limit', String(limit));
    qs.set('page', String(page));
    if (pipeline_id !== undefined) {
      qs.set('filter[statuses][0][pipeline_id]', String(pipeline_id));
      if (status_id !== undefined) qs.set('filter[statuses][0][status_id]', String(status_id));
    }
    if (responsible_user_id !== undefined) qs.set('filter[responsible_user_id][0]', String(responsible_user_id));
    return toToolResult(await kommo.get(`/api/v4/leads?${qs}`));
  },
);

server.tool(
  'get_lead',
  'Get full lead details including linked contacts and tags.',
  { lead_id: z.number().int().describe('Kommo lead id') },
  async ({ lead_id }) => toToolResult(await kommo.get(`/api/v4/leads/${lead_id}?with=contacts,catalog_elements`)),
);

server.tool(
  'list_tasks',
  'List tasks, optionally filtered by entity (lead/contact) or completion state.',
  {
    entity_type: z.enum(['leads', 'contacts']).optional().describe('Scope tasks to this entity type'),
    entity_id: z.number().int().optional().describe('Scope tasks to this specific entity id (requires entity_type)'),
    is_completed: z.boolean().optional().describe('true=only completed, false=only pending. Omit for all.'),
    limit: z.number().int().min(1).max(250).default(50),
  },
  async ({ entity_type, entity_id, is_completed, limit }) => {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (entity_type) qs.set('filter[entity_type]', entity_type);
    if (entity_id !== undefined) qs.set('filter[entity_id]', String(entity_id));
    if (is_completed !== undefined) qs.set('filter[is_completed]', is_completed ? '1' : '0');
    return toToolResult(await kommo.get(`/api/v4/tasks?${qs}`));
  },
);

server.tool(
  'list_tags',
  'List tags defined for a given entity type (leads or contacts).',
  { entity_type: z.enum(['leads', 'contacts']).describe('Entity whose tags to list') },
  async ({ entity_type }) => toToolResult(await kommo.get(`/api/v4/${entity_type}/tags?limit=250`)),
);

// ─── WRITE ─────────────────────────────────────────────────────────────────

server.tool(
  'create_contact',
  'Create a new contact. Provide name and optionally phone/email. Phone/email are added as Kommo custom fields with enum_code WORK.',
  {
    name: z.string().describe('Full name'),
    phone: z.string().optional().describe('Phone number (any format Kommo accepts, e.g. +521...)'),
    email: z.string().optional().describe('Email address'),
    responsible_user_id: z.number().int().optional().describe('Owner user id (see list_users)'),
  },
  async ({ name, phone, email, responsible_user_id }) => {
    const custom_fields_values: Array<{ field_code: string; values: Array<{ value: string; enum_code: string }> }> = [];
    if (phone) custom_fields_values.push({ field_code: 'PHONE', values: [{ value: phone, enum_code: 'WORK' }] });
    if (email) custom_fields_values.push({ field_code: 'EMAIL', values: [{ value: email, enum_code: 'WORK' }] });
    const payload: Record<string, unknown> = { name };
    if (custom_fields_values.length) payload.custom_fields_values = custom_fields_values;
    if (responsible_user_id !== undefined) payload.responsible_user_id = responsible_user_id;
    return toToolResult(await kommo.post('/api/v4/contacts', [payload]));
  },
);

server.tool(
  'create_lead',
  'Create a new lead. Optionally link an existing contact by id. Call list_pipelines first if you need pipeline_id/status_id.',
  {
    name: z.string().describe('Lead name/title'),
    price: z.number().optional().describe('Lead amount (whole number, currency defaults to account default)'),
    pipeline_id: z.number().int().optional().describe('Target pipeline (defaults to account default)'),
    status_id: z.number().int().optional().describe('Target status within the pipeline'),
    contact_id: z.number().int().optional().describe('Existing contact to link (see find_contact / create_contact)'),
    responsible_user_id: z.number().int().optional().describe('Owner user id'),
  },
  async (args) => {
    const payload: Record<string, unknown> = { name: args.name };
    if (args.price !== undefined) payload.price = args.price;
    if (args.pipeline_id !== undefined) payload.pipeline_id = args.pipeline_id;
    if (args.status_id !== undefined) payload.status_id = args.status_id;
    if (args.responsible_user_id !== undefined) payload.responsible_user_id = args.responsible_user_id;
    if (args.contact_id !== undefined) payload._embedded = { contacts: [{ id: args.contact_id }] };
    return toToolResult(await kommo.post('/api/v4/leads', [payload]));
  },
);

server.tool(
  'update_lead',
  'Update an existing lead — change status (move across pipeline), price, name, or responsible user.',
  {
    lead_id: z.number().int().describe('Kommo lead id to update'),
    name: z.string().optional(),
    price: z.number().optional(),
    status_id: z.number().int().optional().describe('Move the lead to this status'),
    pipeline_id: z.number().int().optional().describe('Move across pipelines (normally pair with status_id)'),
    responsible_user_id: z.number().int().optional().describe('Reassign to this user'),
  },
  async ({ lead_id, ...rest }) => {
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) payload[k] = v;
    return toToolResult(await kommo.patch(`/api/v4/leads/${lead_id}`, payload));
  },
);

server.tool(
  'add_note',
  'Add a text note to a lead or contact.',
  {
    entity_type: z.enum(['leads', 'contacts']).describe('Entity type to annotate'),
    entity_id: z.number().int().describe('Entity id'),
    text: z.string().describe('Note body'),
  },
  async ({ entity_type, entity_id, text }) =>
    toToolResult(
      await kommo.post(`/api/v4/${entity_type}/${entity_id}/notes`, [{ note_type: 'common', params: { text } }]),
    ),
);

server.tool(
  'create_task',
  'Create a follow-up task attached to a lead or contact. complete_till accepts ISO-8601 datetime; it is converted to a unix timestamp.',
  {
    text: z.string().describe('Task description'),
    entity_type: z.enum(['leads', 'contacts']).describe('Entity the task is about'),
    entity_id: z.number().int().describe('Entity id'),
    complete_till: z.string().describe('Deadline as ISO-8601 (e.g. 2026-04-20T10:00:00-06:00)'),
    task_type_id: z.number().int().default(1).describe('Task type (1 = Follow-up in most accounts)'),
    responsible_user_id: z.number().int().optional().describe('Assignee user id'),
  },
  async ({ text, entity_type, entity_id, complete_till, task_type_id, responsible_user_id }) => {
    const unix = Math.floor(new Date(complete_till).getTime() / 1000);
    if (!Number.isFinite(unix) || unix <= 0) {
      return { content: [{ type: 'text' as const, text: `Invalid complete_till: "${complete_till}"` }], isError: true };
    }
    const payload: Record<string, unknown> = { text, entity_type, entity_id, complete_till: unix, task_type_id };
    if (responsible_user_id !== undefined) payload.responsible_user_id = responsible_user_id;
    return toToolResult(await kommo.post('/api/v4/tasks', [payload]));
  },
);

// ─── TAGS (read-modify-write to handle Kommo's replace-on-PATCH semantics) ───

async function fetchLeadTagNames(lead_id: number): Promise<string[]> {
  const res = await kommo.get<{ _embedded?: { tags?: Array<{ name: string }> } }>(`/api/v4/leads/${lead_id}`);
  if (!res.ok) return [];
  return (res.data?._embedded?.tags || []).map((t) => t.name).filter(Boolean);
}

async function fetchContactTagNames(contact_id: number): Promise<string[]> {
  const res = await kommo.get<{ _embedded?: { tags?: Array<{ name: string }> } }>(`/api/v4/contacts/${contact_id}`);
  if (!res.ok) return [];
  return (res.data?._embedded?.tags || []).map((t) => t.name).filter(Boolean);
}

server.tool(
  'add_tags_to_lead',
  "Add tags to a lead. Existing tags are preserved (read-modify-write). Kommo creates new tags on the fly if a given name doesn't exist yet.",
  {
    lead_id: z.number().int(),
    tags: z.array(z.string().min(1)).min(1).describe('Tag names to add'),
  },
  async ({ lead_id, tags }) => {
    const current = await fetchLeadTagNames(lead_id);
    const merged = Array.from(new Set([...current, ...tags]));
    return toToolResult(
      await kommo.patch(`/api/v4/leads/${lead_id}`, { _embedded: { tags: merged.map((name) => ({ name })) } }),
    );
  },
);

server.tool(
  'remove_tags_from_lead',
  'Remove specific tags from a lead. Uses read-modify-write: fetches current tags, removes the named ones, PATCHes the rest.',
  {
    lead_id: z.number().int(),
    tags: z.array(z.string().min(1)).min(1).describe('Tag names to remove'),
  },
  async ({ lead_id, tags }) => {
    const current = await fetchLeadTagNames(lead_id);
    const toRemove = new Set(tags);
    const kept = current.filter((n) => !toRemove.has(n));
    return toToolResult(
      await kommo.patch(`/api/v4/leads/${lead_id}`, { _embedded: { tags: kept.map((name) => ({ name })) } }),
    );
  },
);

server.tool(
  'add_tags_to_contact',
  "Add tags to a contact. Existing tags are preserved (read-modify-write). Kommo creates new tags on the fly if needed.",
  {
    contact_id: z.number().int(),
    tags: z.array(z.string().min(1)).min(1),
  },
  async ({ contact_id, tags }) => {
    const current = await fetchContactTagNames(contact_id);
    const merged = Array.from(new Set([...current, ...tags]));
    return toToolResult(
      await kommo.patch(`/api/v4/contacts/${contact_id}`, { _embedded: { tags: merged.map((name) => ({ name })) } }),
    );
  },
);

server.tool(
  'remove_tags_from_contact',
  'Remove specific tags from a contact. Uses read-modify-write.',
  {
    contact_id: z.number().int(),
    tags: z.array(z.string().min(1)).min(1),
  },
  async ({ contact_id, tags }) => {
    const current = await fetchContactTagNames(contact_id);
    const toRemove = new Set(tags);
    const kept = current.filter((n) => !toRemove.has(n));
    return toToolResult(
      await kommo.patch(`/api/v4/contacts/${contact_id}`, { _embedded: { tags: kept.map((name) => ({ name })) } }),
    );
  },
);

// ─── start stdio transport ───
const transport = new StdioServerTransport();
await server.connect(transport);
