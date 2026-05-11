/**
 * Formmy WhatsApp Business API Channel
 *
 * Connects NanoClaw to Formmy's WhatsApp Business API via HTTP.
 *
 * ENV:
 *   FORMMY_CHANNEL_SECRET   — Shared secret for Bearer auth (required)
 *   FORMMY_CALLBACK_URL     — URL to POST responses (required, e.g. https://formmy.app/api/v1/integrations/whatsapp/send)
 *   FORMMY_INTEGRATION_ID   — Formmy integration ID (required)
 *   FORMMY_CHANNEL_PORT     — HTTP listen port (default: 3940)
 *
 * Inbound (Formmy -> NanoClaw):
 *   POST /message with Authorization: Bearer {secret}
 *   Body: { jid, sender, sender_name, content, message_id?, media? }
 *
 * Outbound (NanoClaw -> Formmy):
 *   POST {callback_url} with JSON body
 */
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';

import { FORMMY_PUBLIC_TEMPLATE, GROUPS_DIR } from '../config.js';
import {
  getFormmyGroupFolder,
  getFormmyIntegrationId,
  registerFormmyUserGroup,
  setFormmyJidMapping,
} from '../db.js';
import { logger } from '../logger.js';
import { Channel, NewMessage } from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const CHANNEL_NAME = 'formmy-whatsapp';
const JID_PREFIX = 'formmy_';

// Module-level keep-alive agents so outbound POSTs to FORMMY_CALLBACK_URL reuse
// TCP/TLS connections across calls. Without this, every send to Formmy pays a
// full handshake (~100-200ms on TLS) and we exhaust local ports under load.
const httpsKeepAliveAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 10,
});
const httpKeepAliveAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 10,
});

// Retry config for postToFormmy. Mirrors the exponential-backoff shape used in
// src/group-queue.ts (BASE * 2^(n-1)) but tuned shorter since the WA user is
// already waiting on the response.
const FORMMY_POST_MAX_ATTEMPTS = 3;
const FORMMY_POST_BASE_BACKOFF_MS = 1000;
const FORMMY_POST_TIMEOUT_MS = 15_000;

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Defensive: JIDs already match the group-folder regex (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`),
// but if Formmy ever changes format, replace any unsafe char with underscore.
function sanitizeFolder(jid: string): string {
  return jid.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

interface InboundMedia {
  type: 'image' | 'sticker' | 'document' | 'audio';
  media_id?: string;
  url?: string;
  mime_type?: string;
  caption?: string;
  filename?: string;
}

export class FormmyWhatsAppChannel implements Channel {
  name = CHANNEL_NAME;

  private server: http.Server | null = null;
  private connected = false;
  private port: number;
  private secret: string;
  private callbackUrl: string;
  private integrationId: string | null;
  private opts: ChannelOpts;

  constructor(
    opts: ChannelOpts,
    port: number,
    secret: string,
    callbackUrl: string,
    integrationId: string | null,
  ) {
    this.opts = opts;
    this.port = port;
    this.secret = secret;
    this.callbackUrl = callbackUrl;
    this.integrationId = integrationId;
  }

  async connect(): Promise<void> {
    this.server = http.createServer(async (req, res) => {
      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        res.end();
        return;
      }

      if (req.method !== 'POST' || req.url !== '/message') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      // Auth check
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${this.secret}`) {
        res.writeHead(401);
        res.end('Unauthorized');
        return;
      }

      try {
        const body = await readBody(req);
        const {
          jid,
          sender,
          sender_name,
          content,
          message_id,
          media,
          group_folder,
          integration_id,
          manual_mode,
          container_config,
        } = JSON.parse(body);

        if (!jid || (!content && !media)) {
          res.writeHead(400);
          res.end('Missing jid or content/media');
          return;
        }

        const fullJid = jid.startsWith(JID_PREFIX)
          ? jid
          : `${JID_PREFIX}${jid}`;

        // Resolve group via mapping table.
        // Three modes (priority order):
        //   1. Cache hit on JID → use directly.
        //   2. Explicit `group_folder` from Formmy → respect (shared lobby /
        //      multi-user agent). Update mapping if it changed.
        //   3. No mapping yet → auto-provision a per-user folder named after
        //      the JID itself (already globally unique). Each WABA end-user
        //      gets isolated CLAUDE.md, attachments, IPC, .claude/ session.
        //      Inherits FORMMY_PUBLIC_TEMPLATE — sandboxed profile, no global,
        //      restricted MCP toolsets, granular tool allowlist.
        const groups = this.opts.registeredGroups();
        let group: import('../types.js').RegisteredGroup | undefined =
          groups[fullJid];

        if (!group) {
          const existingFolder = getFormmyGroupFolder(fullJid);
          let resolvedFolder: string;

          if (group_folder) {
            // Explicit override from Formmy (shared/lobby case).
            resolvedFolder = group_folder;
            if (existingFolder !== group_folder) {
              setFormmyJidMapping(fullJid, group_folder, integration_id);
              logger.info(
                { jid: fullJid, from: existingFolder, to: group_folder },
                '[formmy-whatsapp] JID mapped to explicit group_folder',
              );
            }
          } else if (existingFolder) {
            // Already mapped from a previous webhook.
            resolvedFolder = existingFolder;
          } else {
            // New WABA user — auto-provision isolated folder = JID.
            // sanitizeFolder is defensive; the JID format already matches the
            // group-folder regex, so this is a no-op in practice.
            //
            // Template selection: per-tenant container_config from Formmy
            // (Agent.containerConfig, forwarded by handleChannelMessage) wins
            // when present and well-shaped. Else fall back to the hardcoded
            // FORMMY_PUBLIC_TEMPLATE — every Formmy customer gets the safe
            // default for their first integration, even without explicit
            // per-Agent config. The shape check is best-effort; if Formmy
            // sends garbage, NanoClaw still has a working default.
            resolvedFolder = sanitizeFolder(fullJid);
            const isValidConfig =
              container_config &&
              typeof container_config === 'object' &&
              !Array.isArray(container_config);
            const template = isValidConfig
              ? (container_config as typeof FORMMY_PUBLIC_TEMPLATE)
              : FORMMY_PUBLIC_TEMPLATE;
            const created = registerFormmyUserGroup(
              fullJid,
              resolvedFolder,
              sender_name || 'WhatsApp User',
              template,
            );
            // Materialize the folder on disk so attachments/CLAUDE.md can land here.
            fs.mkdirSync(path.join(GROUPS_DIR, resolvedFolder), {
              recursive: true,
            });
            setFormmyJidMapping(fullJid, resolvedFolder, integration_id);
            logger.info(
              { jid: fullJid, folder: resolvedFolder, created },
              '[formmy-whatsapp] Auto-provisioned per-user public group',
            );
          }

          group = Object.values(groups).find(
            (g) => g.folder === resolvedFolder,
          );
          // Cache miss is fine — index.ts:processGroupMessages re-loads from DB
          // when it can't find the JID in the in-memory cache.
        }

        const groupFolder = group?.folder;

        let finalContent = content || '';

        // Handle media attachments
        if (media && groupFolder) {
          finalContent = await this.processMedia(
            media as InboundMedia,
            groupFolder,
            finalContent,
          );
        }

        if (!finalContent) {
          res.writeHead(400);
          res.end('No content after processing');
          return;
        }

        const message: NewMessage = {
          id:
            message_id ||
            `fwa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          chat_jid: fullJid,
          sender: sender || fullJid,
          sender_name: sender_name || 'WhatsApp User',
          content: finalContent,
          timestamp: new Date().toISOString(),
          manual_mode: manual_mode === true,
        };

        // Deliver metadata for chat discovery
        this.opts.onChatMetadata(
          fullJid,
          message.timestamp,
          sender_name,
          CHANNEL_NAME,
          false,
        );

        // Deliver message to NanoClaw message loop
        this.opts.onMessage(fullJid, message);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: message.id }));
      } catch (err) {
        logger.error(
          { err },
          '[formmy-whatsapp] Failed to process inbound message',
        );
        res.writeHead(500);
        res.end('Internal error');
      }
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, () => {
        this.connected = true;
        logger.info({ port: this.port }, '[formmy-whatsapp] Channel listening');
        resolve();
      });
    });
  }

  private resolveIntegrationId(jid: string): string {
    const id = getFormmyIntegrationId(jid) || this.integrationId;
    if (!id) {
      throw new Error(
        `[formmy-whatsapp] No integration_id for JID ${jid}: no formmy_jid_mapping row and no FORMMY_INTEGRATION_ID fallback. Outbound aborted to avoid misrouting.`,
      );
    }
    return id;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    await this.postToFormmy({
      phone_number: extractPhone(jid),
      integration_id: this.resolveIntegrationId(jid),
      type: 'text',
      text,
    });
  }

  async sendImage(
    jid: string,
    filePath: string,
    caption: string,
  ): Promise<void> {
    const buffer = fs.readFileSync(filePath);
    const base64 = buffer.toString('base64');
    await this.postToFormmy({
      phone_number: extractPhone(jid),
      integration_id: this.resolveIntegrationId(jid),
      type: 'image',
      media_base64: base64,
      caption,
    });
  }

  async sendSticker(jid: string, filePath: string): Promise<void> {
    const buffer = fs.readFileSync(filePath);
    const base64 = buffer.toString('base64');
    await this.postToFormmy({
      phone_number: extractPhone(jid),
      integration_id: this.resolveIntegrationId(jid),
      type: 'sticker',
      media_base64: base64,
    });
  }

  async sendDocument(
    jid: string,
    filePath: string,
    filename: string,
    caption: string,
  ): Promise<void> {
    const buffer = fs.readFileSync(filePath);
    const base64 = buffer.toString('base64');
    await this.postToFormmy({
      phone_number: extractPhone(jid),
      integration_id: this.resolveIntegrationId(jid),
      type: 'document',
      media_base64: base64,
      filename,
      caption,
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    logger.info('[formmy-whatsapp] Channel disconnected');
  }

  // --- Private helpers ---

  private async processMedia(
    media: InboundMedia,
    groupFolder: string,
    existingContent: string,
  ): Promise<string> {
    const downloadUrl = media.url;
    if (!downloadUrl) {
      logger.warn(
        { media_id: media.media_id },
        '[formmy-whatsapp] No URL in media — cannot download (media_id only not supported)',
      );
      return existingContent || `[Media: ${media.type} — download URL missing]`;
    }

    try {
      const buffer = await downloadFile(downloadUrl);
      const groupDir = path.join(GROUPS_DIR, groupFolder);

      switch (media.type) {
        case 'image': {
          const attachDir = path.join(groupDir, 'attachments');
          fs.mkdirSync(attachDir, { recursive: true });
          const filename = `img-${Date.now()}.jpg`;
          fs.writeFileSync(path.join(attachDir, filename), buffer);
          const caption = media.caption || existingContent || '';
          return caption
            ? `[Image: attachments/${filename}]\n${caption}`
            : `[Image: attachments/${filename}]`;
        }
        case 'sticker': {
          const stickerDir = path.join(groupDir, 'stickers');
          fs.mkdirSync(stickerDir, { recursive: true });
          const filename = `sticker-${Date.now()}.webp`;
          fs.writeFileSync(path.join(stickerDir, filename), buffer);
          return `[Sticker: stickers/${filename}]`;
        }
        case 'document': {
          const attachDir = path.join(groupDir, 'attachments');
          fs.mkdirSync(attachDir, { recursive: true });
          const filename =
            media.filename ||
            `doc-${Date.now()}${extFromMime(media.mime_type)}`;
          fs.writeFileSync(path.join(attachDir, filename), buffer);
          const sizeKB = Math.round(buffer.length / 1024);
          const caption = media.caption || existingContent || '';
          const docRef = `[Document: attachments/${filename} (${sizeKB}KB)]`;
          return caption ? `${caption}\n\n${docRef}` : docRef;
        }
        case 'audio': {
          const attachDir = path.join(groupDir, 'attachments');
          fs.mkdirSync(attachDir, { recursive: true });
          const filename = `audio-${Date.now()}.ogg`;
          fs.writeFileSync(path.join(attachDir, filename), buffer);
          return `[Audio: attachments/${filename}]`;
        }
        default:
          return existingContent || `[Media: ${media.type}]`;
      }
    } catch (err) {
      logger.warn(
        { err, type: media.type },
        '[formmy-whatsapp] Failed to download media',
      );
      return existingContent || `[Media: ${media.type} — download failed]`;
    }
  }

  private async postToFormmy(payload: Record<string, unknown>): Promise<void> {
    const data = JSON.stringify(payload);
    const url = new URL(this.callbackUrl);
    const isHttps = url.protocol === 'https:';

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= FORMMY_POST_MAX_ATTEMPTS; attempt++) {
      try {
        await this.attemptPostToFormmy(url, isHttps, data, payload.type);
        return;
      } catch (err) {
        lastError = err as Error;
        const retryable = (err as { retryable?: boolean }).retryable !== false;
        if (!retryable || attempt === FORMMY_POST_MAX_ATTEMPTS) {
          break;
        }
        const delay = FORMMY_POST_BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
        logger.warn(
          {
            err,
            type: payload.type,
            attempt,
            nextDelayMs: delay,
          },
          '[formmy-whatsapp] Callback attempt failed, retrying',
        );
        await sleep(delay);
      }
    }

    logger.error(
      {
        err: lastError,
        type: payload.type,
        attempts: FORMMY_POST_MAX_ATTEMPTS,
      },
      '[formmy-whatsapp] Callback failed after all retries',
    );
    throw lastError ?? new Error('postToFormmy failed');
  }

  private attemptPostToFormmy(
    url: URL,
    isHttps: boolean,
    data: string,
    payloadType: unknown,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const transport = isHttps ? https : http;
      const agent = isHttps ? httpsKeepAliveAgent : httpKeepAliveAgent;

      const req = transport.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
            Authorization: `Bearer ${this.secret}`,
          },
          agent,
        },
        (res) => {
          // Collect the body so we can log Meta's wamid / Formmy's response
          // shape; bounded to 1 KB to keep logs sane on rare large payloads.
          const chunks: Buffer[] = [];
          let received = 0;
          const bodyCap = 1024;
          res.on('data', (chunk: Buffer) => {
            if (received < bodyCap) {
              chunks.push(chunk);
              received += chunk.length;
            }
          });
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            const body = Buffer.concat(chunks)
              .toString('utf8')
              .slice(0, bodyCap);
            if (status >= 200 && status < 300) {
              logger.info(
                { status, type: String(payloadType), body },
                '[formmy-whatsapp] Callback ok',
              );
              resolve();
              return;
            }
            const retryable = isRetryableStatus(status);
            const err = Object.assign(
              new Error(
                `[formmy-whatsapp] Callback ${status} for type=${String(payloadType)} body=${body}`,
              ),
              { status, retryable, body },
            );
            reject(err);
          });
          res.on('error', (err) => {
            reject(Object.assign(err, { retryable: true }));
          });
        },
      );

      req.setTimeout(FORMMY_POST_TIMEOUT_MS, () => {
        req.destroy(
          Object.assign(
            new Error(
              `[formmy-whatsapp] Callback timeout after ${FORMMY_POST_TIMEOUT_MS}ms`,
            ),
            { retryable: true },
          ),
        );
      });

      req.on('error', (err) => {
        if (!(err as { retryable?: boolean }).retryable) {
          (err as { retryable?: boolean }).retryable = true;
        }
        reject(err);
      });

      req.write(data);
      req.end();
    });
  }
}

export function extractPhone(jid: string): string {
  // formmy_<integrationId>_<phone> → phone (also handles legacy formmy_<phone>)
  // Also strips the WhatsApp suffix so the value is a clean E.164 number;
  // Formmy forwards this verbatim to Meta Graph API, which silently no-ops
  // (200 OK without delivery) when the recipient carries `@s.whatsapp.net`.
  const stripped = jid
    .replace(/^formmy_/, '')
    .replace(/@s\.whatsapp\.net$/, '')
    .replace(/@c\.us$/, '');
  const parts = stripped.split('_');
  // Integration IDs are 24-char hex (MongoDB ObjectId)
  if (parts.length > 1 && /^[a-f0-9]{24}$/.test(parts[0])) {
    return parts.slice(1).join('_');
  }
  return stripped;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function downloadFile(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith('https') ? https : http;
    transport
      .get(url, (res) => {
        // Follow redirects
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          downloadFile(res.headers.location).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk as Buffer));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

function extFromMime(mime?: string): string {
  if (!mime) return '';
  const map: Record<string, string> = {
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'text/csv': '.csv',
    'application/json': '.json',
    'application/msword': '.doc',
  };
  return map[mime] || '';
}

// Self-register
registerChannel(CHANNEL_NAME, (opts: ChannelOpts) => {
  const port = parseInt(process.env.FORMMY_CHANNEL_PORT || '3940', 10);
  const secret = process.env.FORMMY_CHANNEL_SECRET;
  const callbackUrl = process.env.FORMMY_CALLBACK_URL;
  // Optional: integration_id is normally received per-JID in each inbound
  // forward (saved to formmy_jid_mapping) and resolved at outbound time.
  // The env fallback only matters for outbound to JIDs without a mapping yet,
  // which shouldn't happen in normal flow.
  const integrationId = process.env.FORMMY_INTEGRATION_ID || null;

  if (!secret || !callbackUrl) {
    return null; // Credentials missing -- skip
  }

  return new FormmyWhatsAppChannel(
    opts,
    port,
    secret,
    callbackUrl,
    integrationId,
  );
});
