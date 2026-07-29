import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'FORMMY_TRAINING_GROUP_FOLDER',
  'FORMMY_PUBLIC_EXTRA_MCP',
  'FORMMY_PUBLIC_EASYBITS_FULL',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
// Folder (under GROUPS_DIR) whose contents — CLAUDE.md, catalog, product
// images — are mounted read-only into every Formmy WABA per-user container
// as /workspace/extra/training. Use it so an internal "training" group's
// prompt and assets become the live production source-of-truth for the
// public agent. Empty → no training mount (default for droplets that
// don't use this pattern). Anything sensitive in the folder should live
// under a `.private/` subfolder; the agent's Read/Glob/Grep tools can
// reach anything else in the mount.
export const FORMMY_TRAINING_GROUP_FOLDER =
  process.env.FORMMY_TRAINING_GROUP_FOLDER?.trim() ||
  envConfig.FORMMY_TRAINING_GROUP_FOLDER?.trim() ||
  '';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
// How long a container may go without ANY sign of progress before we call it
// stalled and reap it. Progress = a streamed output marker OR the agent-runner
// turn counter advancing (see PROGRESS_LINE_PATTERN in container-runner.ts).
// Long jobs that keep working are never killed by this — only genuinely stuck
// ones. The longest legitimate silence observed in production is an autocompact
// (~2.5min), so 60min leaves a wide margin.
export const CONTAINER_STALL_TIMEOUT = parseInt(
  process.env.CONTAINER_STALL_TIMEOUT || '3600000',
  10,
); // 60min default
// Absolute backstop on container lifetime, regardless of progress. Guards
// against a genuinely runaway agent looping forever. Set to 0 to disable.
export const CONTAINER_MAX_LIFETIME = parseInt(
  process.env.CONTAINER_MAX_LIFETIME || '259200000',
  10,
); // 3 days default, 0 = unlimited
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '8', 10) || 8,
);

/**
 * Rotate a conversation's session once it reaches this age, in days. 0 disables it.
 *
 * Sessions previously only rotated on size (>4MB), so a low-traffic chat could stay alive for
 * months and keep serving stale facts out of its own transcript — that's how a WhatsApp sales
 * agent quoted a customer a price that had changed six weeks earlier. 14 days is ~4x the
 * observed price-change cadence while still preserving "you quoted me last week" continuity;
 * 30 days would have permitted that exact incident.
 *
 * Ships disabled: enable per droplet once the price guard has been proven.
 */
export const SESSION_TTL_DAYS = Math.max(
  0,
  parseInt(process.env.SESSION_TTL_DAYS || '0', 10) || 0,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

import type { ContainerConfig } from './types.js';

// Default container_config inherited by every auto-registered Formmy WABA user group.
// Each end-user gets their own folder + this template; admin overrides per-row in DB.
// Layered defense:
//   - profile=public: container-runner omits /workspace/global, uses skills-public/agents-public
//   - mcpServers + env toolsets: nanoclaw/kommo MCPs only register safe tool subsets
//     at registration time. easybits is upstream — `EASYBITS_TOOLSETS=public-safe`
//     scopes its tools/list (UX optimization, fewer tokens), but the server's
//     `discover_tools`/`run_tool` can still reach disabled tools, so real
//     enforcement lives in allowedTools below (Capa 1 wildcard suppression).
//   - allowedTools (granular): list each easybits tool by name. The presence of
//     specific `mcp__easybits__<name>` entries makes `buildAllowedTools()` drop
//     the wildcard `mcp__easybits__*`, blocking access to discover_tools/run_tool
//     and every tool not listed here.
//   - nanoclaw/kommo use wildcard since their toolsets already filter at registration
//     and they don't expose discover_tools-style escape hatches.
export const FORMMY_PUBLIC_TEMPLATE: ContainerConfig = {
  profile: 'public',
  mcpServers: ['nanoclaw', 'kommo', 'easybits', 'skydropx'],
  env: {
    NANOCLAW_TOOLSETS: 'messaging-public,scheduling-self,quote',
    // Kommo public surface: list_pipelines/list_tags (account-level structure)
    // + create_lead/contact/note/task/add_tags + update_lead/remove_tags
    // Excludes 'read-leads' (no enumeration of other customers' leads) and
    // 'admin' (no list_users, no pipeline CRUD).
    KOMMO_TOOLSETS: 'read,create,scoped-mutate',
    // Per-JID tenancy: every lead this conversation creates carries an opaque
    // scope tag derived from NANOCLAW_CHAT_JID. update_lead / add_note /
    // add_tags_to_lead / remove_tags_from_lead verify ownership before
    // mutating. See container/mcp-servers/kommo/src/index.ts.
    KOMMO_SCOPE_BY_JID: '1',
    EASYBITS_TOOLSETS: 'public-safe',
  },
  allowedTools: [
    'Read',
    'Write',
    'Glob',
    'Grep',
    // easybits: minimal 3-tool surface for B2C. Capa 1 suppresses the server
    // wildcard, which also blocks discover_tools/run_tool escape hatches.
    // db_select is the SELECT-only hardened variant (anti-stacking,
    // anti-CROSS-JOIN, anti-sqlite_master) — see easybits server.ts. To
    // grant a tenant generate_image/voice_tts_create/get_file, override
    // allowedTools per-group in container_config — don't expand this default.
    'mcp__easybits__upload_file',
    'mcp__easybits__create_share_link',
    'mcp__easybits__db_select',
    // skydropx: quote-only. Listing the specific tool suppresses the wildcard,
    // which blocks skydropx_create_shipment (gasta saldo de la cuenta Skydropx
    // del cliente — abuse vector), skydropx_cancel, and skydropx_track. Quote
    // is read-only (no state, no charges) — only returns rates. Used to inline
    // shipping cost into siiqtec_quote_pdf flow.
    'mcp__skydropx__skydropx_quote',
    // nanoclaw/kommo: server-side toolsets restrict; wildcards safe here
    'mcp__nanoclaw__*',
    'mcp__kommo__*',
  ],
};

// Droplet-scoped extra MCP servers for public WABA chats. Comma-separated env
// (e.g. FORMMY_PUBLIC_EXTRA_MCP=coregrid-crm) appended to the public template's
// mcpServers. Lets a single demo droplet (ghosty-0 / CoreGrid) grant its public
// chats an extra server WITHOUT changing the shared default for every other
// droplet — inert wherever the env is unset. The extra server's secret (e.g.
// CRM_API_KEY) is injected by container-runner from .env, and a per-chat
// container_config.env can still override it; its tools auto-wildcard in
// buildAllowedTools (no allowedTools entry needed).
const extraPublicMcp = (
  process.env.FORMMY_PUBLIC_EXTRA_MCP ||
  envConfig.FORMMY_PUBLIC_EXTRA_MCP ||
  ''
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (extraPublicMcp.length) {
  FORMMY_PUBLIC_TEMPLATE.mcpServers = [
    ...new Set([
      ...(FORMMY_PUBLIC_TEMPLATE.mcpServers ?? []),
      ...extraPublicMcp,
    ]),
  ];
  // CoreGrid CRM en chats públicos: ownership por-JID (cada chat solo ve/edita
  // los deals/contactos que él creó) + superficie acotada a deals,contacts —
  // sin delete, coexistencia ni escalamiento, que son de operador. Mismo patrón
  // que KOMMO_SCOPE_BY_JID. Inerte donde coregrid-crm no esté en los extras.
  if (extraPublicMcp.includes('coregrid-crm') && FORMMY_PUBLIC_TEMPLATE.env) {
    FORMMY_PUBLIC_TEMPLATE.env.CRM_SCOPE_BY_JID = '1';
    FORMMY_PUBLIC_TEMPLATE.env.CRM_TOOLSETS = 'deals,contacts';
  }
}

// Droplet-scoped: give public WABA chats the FULL easybits surface (image/video/
// voice generation), matching the trainer group. Drops the public-safe toolset
// scoping (EASYBITS_TOOLSETS) and widens allowedTools to the mcp__easybits__*
// wildcard. For demo droplets (ghosty-0 / CoreGrid) where public chats are a
// controlled showcase, NOT untrusted B2C — the default elsewhere stays the
// hardened 3-tool surface. Inert when unset.
if (
  (
    process.env.FORMMY_PUBLIC_EASYBITS_FULL ||
    envConfig.FORMMY_PUBLIC_EASYBITS_FULL ||
    ''
  ).trim()
) {
  if (FORMMY_PUBLIC_TEMPLATE.env) {
    delete FORMMY_PUBLIC_TEMPLATE.env.EASYBITS_TOOLSETS;
  }
  FORMMY_PUBLIC_TEMPLATE.allowedTools = [
    ...(FORMMY_PUBLIC_TEMPLATE.allowedTools ?? []).filter(
      (t) => !t.startsWith('mcp__easybits__'),
    ),
    'mcp__easybits__*',
  ];
}
