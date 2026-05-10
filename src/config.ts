import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER']);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
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
//   - allowedTools (granular): easybits is upstream so we can't filter at registration —
//     listed by name. Capa 1 in agent-runner suppresses the wildcard `mcp__easybits__*`.
//   - nanoclaw/kommo use wildcard since their toolsets already filter at registration.
export const FORMMY_PUBLIC_TEMPLATE: ContainerConfig = {
  profile: 'public',
  mcpServers: ['nanoclaw', 'kommo', 'easybits'],
  env: {
    NANOCLAW_TOOLSETS: 'messaging-public,scheduling-self,quote',
    KOMMO_TOOLSETS: 'read,create,scoped-mutate',
  },
  allowedTools: [
    'Read',
    'Write',
    'Glob',
    'Grep',
    // easybits: granular allowlist (Capa 1 suppresses the server wildcard)
    'mcp__easybits__list_files',
    'mcp__easybits__get_file',
    'mcp__easybits__upload_file',
    'mcp__easybits__create_share_link',
    'mcp__easybits__db_list',
    'mcp__easybits__db_query',
    'mcp__easybits__generate_image',
    'mcp__easybits__voice_tts_create',
    // nanoclaw/kommo: server-side toolsets restrict; wildcards safe here
    'mcp__nanoclaw__*',
    'mcp__kommo__*',
  ],
};
