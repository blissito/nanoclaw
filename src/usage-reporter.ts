/**
 * Per-turn usage reporter for Ghosty Studio.
 *
 * After each user-visible assistant reply, posts one row to ghosty.studio
 * with the SDK-reported token counts. Fire-and-forget: failures are logged
 * and dropped (no disk retry) so they cannot impact the reply path.
 *
 * Auth: Bearer NANOCLAW_ADMIN_TOKEN (the same token admin-api.ts uses).
 * If the token is missing, reporting is disabled and a warning is logged
 * once at startup; older droplets without the token keep working.
 */
import { request as httpsRequest } from 'https';
import { request as httpRequest } from 'http';

import { logger } from './logger.js';

const DEFAULT_ENDPOINT = 'https://ghosty.studio/api/usage';
const REQUEST_TIMEOUT_MS = 5_000;

interface ReporterConfig {
  url: URL;
  token: string;
}

let config: ReporterConfig | null = null;
let initialized = false;

export function initUsageReporter(): void {
  if (initialized) return;
  initialized = true;

  const token = process.env.NANOCLAW_ADMIN_TOKEN;
  if (!token) {
    logger.warn(
      {},
      'usage-reporter: NANOCLAW_ADMIN_TOKEN not set, usage reports disabled',
    );
    return;
  }

  const endpoint = process.env.GHOSTY_STUDIO_USAGE_URL || DEFAULT_ENDPOINT;
  try {
    config = { url: new URL(endpoint), token };
    logger.info(
      { endpoint: config.url.toString() },
      'usage-reporter: enabled',
    );
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), endpoint },
      'usage-reporter: invalid endpoint URL, reports disabled',
    );
    config = null;
  }
}

export interface TurnUsageReport {
  agent_group_id: string;
  messaging_group_id: string;
  session_id: string;
  turn_idempotency_key: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  service_tier?: string;
  occurred_at: string;
  user_id?: string;
}

export function reportTurnUsage(report: TurnUsageReport): void {
  if (!config) return;

  const payload = JSON.stringify(report);
  const isHttps = config.url.protocol === 'https:';
  const send = isHttps ? httpsRequest : httpRequest;

  const req = send(
    {
      hostname: config.url.hostname,
      port: config.url.port || (isHttps ? 443 : 80),
      path: config.url.pathname + (config.url.search || ''),
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        authorization: `Bearer ${config.token}`,
      },
      timeout: REQUEST_TIMEOUT_MS,
    },
    (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        if (status === 401) {
          logger.error(
            { status, key: report.turn_idempotency_key },
            'usage-reporter: 401 unauthorized — NANOCLAW_ADMIN_TOKEN likely invalid',
          );
          return;
        }
        if (status >= 400) {
          logger.warn(
            {
              status,
              key: report.turn_idempotency_key,
              body: Buffer.concat(chunks).toString().slice(0, 200),
            },
            'usage-reporter: non-2xx response, dropping report',
          );
          return;
        }
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          if (body && body.recorded === false && body.reason === 'duplicate') {
            logger.info(
              { key: report.turn_idempotency_key },
              'usage-reporter: duplicate (idempotent retry)',
            );
          }
        } catch {
          /* response body wasn't JSON — still 2xx, treat as success */
        }
      });
      res.on('error', () => {
        /* drained anyway */
      });
    },
  );

  req.on('timeout', () => {
    req.destroy();
    logger.warn(
      { key: report.turn_idempotency_key, timeoutMs: REQUEST_TIMEOUT_MS },
      'usage-reporter: timed out, dropping report',
    );
  });
  req.on('error', (err) => {
    logger.warn(
      { err: err.message, key: report.turn_idempotency_key },
      'usage-reporter: network error, dropping report',
    );
  });

  req.write(payload);
  req.end();
}
