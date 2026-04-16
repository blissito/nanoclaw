/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Primary: OAuth (Max plan).
 * Fallback: If upstream returns 429 (rate limit) and an API key is
 *           configured, retries with API key + claude-sonnet-4-20250514.
 *
 * Vault features (inspired by OneCLI — github.com/onecli/onecli):
 * - Per-group rate limiting policies
 * - Usage logging (tokens, cost, model per request)
 * - Policy enforcement before forwarding
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

const FALLBACK_MODEL = 'claude-sonnet-4-20250514';

// ---------------------------------------------------------------------------
// Vault: Per-group policies
// ---------------------------------------------------------------------------

export interface GroupPolicy {
  /** Max requests per window (0 = unlimited) */
  maxRequestsPerWindow: number;
  /** Window size in ms (default: 1 hour) */
  windowMs: number;
  /** Allowed models (empty = all allowed) */
  allowedModels: string[];
  /** Max input tokens per request (0 = unlimited) */
  maxInputTokens: number;
  /** Block the group entirely */
  blocked: boolean;
}

const DEFAULT_POLICY: GroupPolicy = {
  maxRequestsPerWindow: 0,
  windowMs: 3600_000,
  allowedModels: [],
  maxInputTokens: 0,
  blocked: false,
};

// In-memory policy store. Loaded from container_config.policy in DB at startup.
// Future: hot-reload from DB or /nanoclaw/vault/policy endpoint.
const groupPolicies = new Map<string, GroupPolicy>();

export function setGroupPolicy(
  groupFolder: string,
  policy: Partial<GroupPolicy>,
): void {
  groupPolicies.set(groupFolder, { ...DEFAULT_POLICY, ...policy });
}

export function getGroupPolicy(groupFolder: string): GroupPolicy {
  return groupPolicies.get(groupFolder) || DEFAULT_POLICY;
}

// ---------------------------------------------------------------------------
// Vault: Rate limiter (sliding window counter)
// ---------------------------------------------------------------------------

interface RateWindow {
  count: number;
  windowStart: number;
}

const rateLimiterState = new Map<string, RateWindow>();

function checkRateLimit(groupFolder: string, policy: GroupPolicy): boolean {
  if (policy.maxRequestsPerWindow <= 0) return true; // unlimited

  const now = Date.now();
  const state = rateLimiterState.get(groupFolder);

  if (!state || now - state.windowStart >= policy.windowMs) {
    rateLimiterState.set(groupFolder, { count: 1, windowStart: now });
    return true;
  }

  if (state.count >= policy.maxRequestsPerWindow) {
    return false; // exceeded
  }

  state.count++;
  return true;
}

// ---------------------------------------------------------------------------
// Vault: Usage logging
// ---------------------------------------------------------------------------

export interface UsageEntry {
  timestamp: string;
  groupFolder: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  durationMs: number;
  authMode: AuthMode;
  wasFallback: boolean;
}

// Ring buffer — keeps last N entries in memory, flushable to DB/disk.
const USAGE_BUFFER_SIZE = 500;
const usageBuffer: UsageEntry[] = [];

function logUsage(entry: UsageEntry): void {
  usageBuffer.push(entry);
  if (usageBuffer.length > USAGE_BUFFER_SIZE) {
    usageBuffer.shift();
  }
  logger.info(
    {
      group: entry.groupFolder,
      model: entry.model,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheRead: entry.cacheReadTokens,
      durationMs: entry.durationMs,
      fallback: entry.wasFallback,
    },
    'vault:usage',
  );
}

/** Get recent usage, optionally filtered by group */
export function getUsage(groupFolder?: string): UsageEntry[] {
  if (!groupFolder) return [...usageBuffer];
  return usageBuffer.filter((e) => e.groupFolder === groupFolder);
}

/** Extract usage from Anthropic response body */
function extractUsage(
  responseBody: Buffer,
): {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
} | null {
  try {
    const parsed = JSON.parse(responseBody.toString());
    if (!parsed.usage) return null;
    return {
      model: parsed.model || 'unknown',
      inputTokens: parsed.usage.input_tokens || 0,
      outputTokens: parsed.usage.output_tokens || 0,
      cacheReadTokens: parsed.usage.cache_read_input_tokens || 0,
      cacheCreationTokens: parsed.usage.cache_creation_input_tokens || 0,
    };
  } catch {
    return null;
  }
}

/** Enforce policy on outbound request. Returns error string or null if OK. */
function enforcePolicy(
  groupFolder: string,
  body: Buffer,
): string | null {
  const policy = getGroupPolicy(groupFolder);

  if (policy.blocked) {
    return 'Group is blocked by vault policy';
  }

  if (!checkRateLimit(groupFolder, policy)) {
    return `Rate limit exceeded: ${policy.maxRequestsPerWindow} requests per ${policy.windowMs / 60000}min`;
  }

  if (policy.allowedModels.length > 0 || policy.maxInputTokens > 0) {
    try {
      const parsed = JSON.parse(body.toString());
      if (
        policy.allowedModels.length > 0 &&
        parsed.model &&
        !policy.allowedModels.includes(parsed.model)
      ) {
        return `Model ${parsed.model} not allowed for this group`;
      }
      // Rough token estimate: 4 chars ≈ 1 token
      if (policy.maxInputTokens > 0) {
        const contentStr = JSON.stringify(parsed.messages || '');
        const estimatedTokens = Math.ceil(contentStr.length / 4);
        if (estimatedTokens > policy.maxInputTokens) {
          return `Estimated input tokens (${estimatedTokens}) exceeds limit (${policy.maxInputTokens})`;
        }
      }
    } catch {
      // Can't parse — let it through
    }
  }

  return null;
}

export interface NanoClawHandlers {
  getInviteLink?: (jid: string) => Promise<string | null>;
  createGroup?: (
    name: string,
  ) => Promise<{ jid: string; inviteLink: string | null }>;
  leaveGroup?: (jid: string) => Promise<{
    jid: string;
    folder: string;
    archivedPath: string | null;
    tasksDeleted: number;
    leftInWhatsApp: boolean;
  }>;
  listArchivedGroups?: () => Promise<
    Array<{
      archivedFolder: string;
      originalFolder: string;
      archivedAt: string;
    }>
  >;
  restoreGroup?: (
    archivedFolder: string,
    jid: string,
    name: string,
    trigger: string,
  ) => Promise<{ jid: string; folder: string; restoredFrom: string }>;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
  handlers: NanoClawHandlers = {},
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  // Primary: OAuth (Max plan). Fallback to API key only if no OAuth token.
  const authMode: AuthMode =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN
      ? 'oauth'
      : secrets.ANTHROPIC_API_KEY
        ? 'api-key'
        : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;
  const canFallback = authMode === 'oauth' && !!secrets.ANTHROPIC_API_KEY;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  function buildUpstreamOpts(
    reqUrl: string | undefined,
    method: string | undefined,
    headers: Record<string, string | number | string[] | undefined>,
  ): RequestOptions {
    return {
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || (isHttps ? 443 : 80),
      path: reqUrl,
      method,
      headers,
    };
  }

  function injectOAuth(
    headers: Record<string, string | number | string[] | undefined>,
    reqUrl: string | undefined,
  ): void {
    const isExchange = reqUrl?.includes('/api/oauth/claude_cli/create_api_key');
    if (isExchange || headers['authorization']) {
      delete headers['x-api-key'];
      delete headers['authorization'];
      if (oauthToken) {
        headers['authorization'] = `Bearer ${oauthToken}`;
      }
    }
  }

  function injectApiKey(
    headers: Record<string, string | number | string[] | undefined>,
  ): void {
    delete headers['x-api-key'];
    delete headers['authorization'];
    headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
  }

  function swapModelInBody(body: Buffer): Buffer {
    try {
      const parsed = JSON.parse(body.toString());
      if (parsed.model) {
        parsed.model = FALLBACK_MODEL;
        return Buffer.from(JSON.stringify(parsed));
      }
    } catch {
      // Not JSON or no model field — send as-is
    }
    return body;
  }

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      // NanoClaw internal endpoints (not proxied to Anthropic)
      if (req.url?.startsWith('/nanoclaw/')) {
        const url = new URL(req.url, `http://${req.headers.host}`);

        if (
          url.pathname === '/nanoclaw/create-group' &&
          req.method === 'POST'
        ) {
          const chunks: Buffer[] = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => {
            try {
              const { name } = JSON.parse(Buffer.concat(chunks).toString());
              if (!name || !handlers.createGroup) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    error: 'Missing name or handler not ready',
                  }),
                );
                return;
              }
              handlers
                .createGroup(name)
                .then((result) => {
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify(result));
                })
                .catch((err) => {
                  logger.error({ err, name }, 'Error creating group');
                  res.writeHead(500, { 'Content-Type': 'application/json' });
                  res.end(
                    JSON.stringify({
                      error:
                        err instanceof Error ? err.message : 'Internal error',
                    }),
                  );
                });
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid JSON body' }));
            }
          });
          return;
        }

        if (url.pathname === '/nanoclaw/leave-group' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => {
            try {
              const { jid } = JSON.parse(Buffer.concat(chunks).toString());
              if (!jid || !handlers.leaveGroup) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({ error: 'Missing jid or handler not ready' }),
                );
                return;
              }
              handlers
                .leaveGroup(jid)
                .then((result) => {
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify(result));
                })
                .catch((err) => {
                  logger.error({ err, jid }, 'Error leaving group');
                  res.writeHead(500, { 'Content-Type': 'application/json' });
                  res.end(
                    JSON.stringify({
                      error:
                        err instanceof Error ? err.message : 'Internal error',
                    }),
                  );
                });
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid JSON body' }));
            }
          });
          return;
        }

        if (
          url.pathname === '/nanoclaw/archived-groups' &&
          req.method === 'GET'
        ) {
          if (!handlers.listArchivedGroups) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Handler not ready' }));
            return;
          }
          handlers
            .listArchivedGroups()
            .then((groups) => {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ groups }));
            })
            .catch((err) => {
              logger.error({ err }, 'Error listing archived groups');
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Internal error' }));
            });
          return;
        }

        if (
          url.pathname === '/nanoclaw/restore-group' &&
          req.method === 'POST'
        ) {
          const chunks: Buffer[] = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => {
            try {
              const { archivedFolder, jid, name, trigger } = JSON.parse(
                Buffer.concat(chunks).toString(),
              );
              if (
                !archivedFolder ||
                !jid ||
                !name ||
                !trigger ||
                !handlers.restoreGroup
              ) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    error:
                      'Missing archivedFolder/jid/name/trigger or handler not ready',
                  }),
                );
                return;
              }
              handlers
                .restoreGroup(archivedFolder, jid, name, trigger)
                .then((result) => {
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify(result));
                })
                .catch((err) => {
                  logger.error(
                    { err, archivedFolder, jid },
                    'Error restoring group',
                  );
                  res.writeHead(500, { 'Content-Type': 'application/json' });
                  res.end(
                    JSON.stringify({
                      error:
                        err instanceof Error ? err.message : 'Internal error',
                    }),
                  );
                });
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid JSON body' }));
            }
          });
          return;
        }

        if (url.pathname === '/nanoclaw/invite-link' && req.method === 'GET') {
          const jid = url.searchParams.get('jid');
          if (!jid || !handlers.getInviteLink) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({ error: 'Missing jid or handler not ready' }),
            );
            return;
          }
          handlers
            .getInviteLink(jid)
            .then((link) => {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ link }));
            })
            .catch((err) => {
              logger.error({ err, jid }, 'Error getting invite link');
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Internal error' }));
            });
          return;
        }

        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      // Vault: usage stats endpoint
      if (req.url?.startsWith('/nanoclaw/vault/usage')) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const group = url.searchParams.get('group') || undefined;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ usage: getUsage(group) }));
        return;
      }

      // Vault: policy management endpoint
      if (
        req.url === '/nanoclaw/vault/policy' &&
        req.method === 'POST'
      ) {
        const pChunks: Buffer[] = [];
        req.on('data', (c) => pChunks.push(c));
        req.on('end', () => {
          try {
            const { groupFolder, policy } = JSON.parse(
              Buffer.concat(pChunks).toString(),
            );
            if (!groupFolder) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Missing groupFolder' }));
              return;
            }
            setGroupPolicy(groupFolder, policy || {});
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                ok: true,
                policy: getGroupPolicy(groupFolder),
              }),
            );
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);

        // Vault: group identification.
        // TODO: map container source IP → group folder via Docker network inspect
        // or accept X-NanoClaw-Group from agent-runner IPC calls (not SDK calls).
        // For now, all SDK traffic logs as 'unknown'. IPC calls can set the header.
        const groupFolder =
          (req.headers['x-nanoclaw-group'] as string) || 'unknown';
        const requestStart = Date.now();

        // Vault: enforce policy before forwarding
        const policyError = enforcePolicy(groupFolder, body);
        if (policyError) {
          logger.warn(
            { group: groupFolder, error: policyError },
            'vault:policy-blocked',
          );
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              type: 'error',
              error: {
                type: 'rate_limit_error',
                message: policyError,
              },
            }),
          );
          return;
        }

        const baseHeaders: Record<
          string,
          string | number | string[] | undefined
        > = {
          ...(req.headers as Record<string, string>),
          host: upstreamUrl.host,
          'content-length': body.length,
        };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete baseHeaders['connection'];
        delete baseHeaders['keep-alive'];
        delete baseHeaders['transfer-encoding'];
        // Strip internal vault header before forwarding to Anthropic
        delete baseHeaders['x-nanoclaw-group'];

        const headers = { ...baseHeaders };

        if (authMode === 'api-key') {
          injectApiKey(headers);
        } else {
          injectOAuth(headers, req.url);
        }

        // Helper: buffer response, log usage, then forward to client
        const bufferAndLog = (
          upRes: import('http').IncomingMessage,
          wasFallback: boolean,
        ) => {
          const respChunks: Buffer[] = [];
          upRes.on('data', (c: Buffer) => respChunks.push(c));
          upRes.on('end', () => {
            const respBody = Buffer.concat(respChunks);
            const usage = extractUsage(respBody);
            if (usage) {
              logUsage({
                timestamp: new Date().toISOString(),
                groupFolder,
                model: usage.model,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cacheReadTokens: usage.cacheReadTokens,
                cacheCreationTokens: usage.cacheCreationTokens,
                durationMs: Date.now() - requestStart,
                authMode: wasFallback ? 'api-key' : authMode,
                wasFallback,
              });
            }
            res.writeHead(upRes.statusCode!, upRes.headers);
            res.end(respBody);
          });
        };

        // Determine if this is a retryable request (messages endpoint, not exchange)
        const isMessagesEndpoint =
          req.url?.includes('/v1/messages') && req.method === 'POST';
        const shouldRetryOn429 = canFallback && isMessagesEndpoint;

        if (!shouldRetryOn429) {
          // No fallback — buffer for usage logging if messages endpoint
          if (isMessagesEndpoint) {
            const upstream = makeRequest(
              buildUpstreamOpts(req.url, req.method, headers),
              (upRes) => bufferAndLog(upRes, false),
            );
            upstream.on('error', (err) => {
              logger.error(
                { err, url: req.url },
                'Credential proxy upstream error',
              );
              if (!res.headersSent) {
                res.writeHead(502);
                res.end('Bad Gateway');
              }
            });
            upstream.write(body);
            upstream.end();
          } else {
            // Non-messages endpoint — pipe directly (fast path, no logging)
            const upstream = makeRequest(
              buildUpstreamOpts(req.url, req.method, headers),
              (upRes) => {
                res.writeHead(upRes.statusCode!, upRes.headers);
                upRes.pipe(res);
              },
            );
            upstream.on('error', (err) => {
              logger.error(
                { err, url: req.url },
                'Credential proxy upstream error',
              );
              if (!res.headersSent) {
                res.writeHead(502);
                res.end('Bad Gateway');
              }
            });
            upstream.write(body);
            upstream.end();
          }
          return;
        }

        // Retryable path — buffer response to check for 429
        const upstream = makeRequest(
          buildUpstreamOpts(req.url, req.method, headers),
          (upRes) => {
            if (upRes.statusCode !== 429) {
              // Not rate limited — buffer for usage logging
              bufferAndLog(upRes, false);
              return;
            }

            // Rate limited — consume the response and retry with API key
            const discardChunks: Buffer[] = [];
            upRes.on('data', (c) => discardChunks.push(c));
            upRes.on('end', () => {
              logger.warn(
                { url: req.url, fallbackModel: FALLBACK_MODEL },
                'Rate limited on OAuth, retrying with API key + fallback model',
              );

              const fallbackBody = swapModelInBody(body);
              const fallbackHeaders = { ...baseHeaders };
              injectApiKey(fallbackHeaders);
              fallbackHeaders['content-length'] = fallbackBody.length;

              const retry = makeRequest(
                buildUpstreamOpts(req.url, req.method, fallbackHeaders),
                (retryRes) => bufferAndLog(retryRes, true),
              );
              retry.on('error', (err) => {
                logger.error(
                  { err, url: req.url },
                  'Credential proxy fallback upstream error',
                );
                if (!res.headersSent) {
                  res.writeHead(502);
                  res.end('Bad Gateway');
                }
              });
              retry.write(fallbackBody);
              retry.end();
            });
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info(
        { port, host, authMode, canFallback },
        'Credential proxy started',
      );
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
  ]);
  return secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN
    ? 'oauth'
    : secrets.ANTHROPIC_API_KEY
      ? 'api-key'
      : 'oauth';
}
