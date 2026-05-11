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
const FORMMY_TRAINING_GROUP_FOLDER =
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
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
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
  ...(FORMMY_TRAINING_GROUP_FOLDER && {
    additionalMounts: [
      {
        hostPath: path.join(GROUPS_DIR, FORMMY_TRAINING_GROUP_FOLDER),
        containerPath: 'training',
        readonly: true,
      },
    ],
  }),
};
