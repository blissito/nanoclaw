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
  clearChatPauseUntil,
  createTask,
  getFormmyIntegrationId,
  isKnownIntegrationId,
  registerFormmyUserGroup,
  setChatPauseUntil,
  setFormmyJidMapping,
} from '../db.js';
// clearChatPauseUntil + setChatPauseUntil are used by the inbound POST /message
// handler (below), driven by Formmy's authoritative `paused_until` field on
// each forwarded customer message. Do NOT call them from outbound /send
// response parsing — that path was tried and abandoned: when the gate skips
// inference, no /send happens, so the flag never clears (deadlock).
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
const FORMMY_POST_TIMEOUT_MS = 30_000;

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

// Parse Formmy response bodies that wrap an upstream Meta error inside a 2xx.
// Returns a short summary string when a wrapped error is found, else null.
// Recognized shape:
//   { "error": "Meta API error",
//     "details": { "error": { "code": 132018, "message": "...",
//                              "error_data": { "details": "..." } } } }
// Also handles a top-level `error` field of any truthy shape as a defensive
// fallback in case the bridge changes envelope keys.
function extractWrappedError(body: string): string | null {
  if (!body) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const top = parsed as { error?: unknown; details?: unknown };
  if (!top.error) return null;
  const innerHolder = top.details as { error?: unknown } | undefined;
  const inner = innerHolder?.error as
    | {
        code?: unknown;
        message?: unknown;
        error_data?: { details?: unknown };
      }
    | undefined;
  if (inner && typeof inner === 'object') {
    const code = inner.code ?? '?';
    const message = typeof inner.message === 'string' ? inner.message : '';
    const sub =
      typeof inner.error_data?.details === 'string'
        ? inner.error_data.details
        : '';
    return `meta_code=${String(code)} message="${message}" details="${sub}"`;
  }
  return typeof top.error === 'string' ? top.error : JSON.stringify(top.error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Guard against sending 0-byte payloads. Previously a bind-mount stub in the
// training overlay caused empty PDFs to ship with a 200 from Formmy — fail
// loudly here so the symptom is visible in logs and the retry loop doesn't
// silently mask it. See src/ipc.ts:resolveMediaPath for the upstream fix.
function readNonEmptyFile(filePath: string, kind: string): Buffer {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length === 0) {
    throw new Error(
      `[formmy-whatsapp] refusing to send empty ${kind} (${filePath})`,
    );
  }
  return buffer;
}

// Defensive: JIDs already match the group-folder regex (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`),
// but if Formmy ever changes format, replace any unsafe char with underscore.
function sanitizeFolder(jid: string): string {
  return jid.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

// Materialize a Formmy group folder on disk. Creates the directory, seeds
// CLAUDE.md from groups/_training/formmy-public.md, and copies any
// executable in groups/_training/bin/ into the group's bin/ with +x bits.
// Idempotent — safe to call when the folder already has files. Failures
// are warned (not thrown) so a missing training file doesn't block message
// delivery; the group can still operate with an empty CLAUDE.md.
function seedFormmyGroupFiles(folder: string): void {
  const groupDir = path.join(GROUPS_DIR, folder);
  fs.mkdirSync(groupDir, { recursive: true });
  const trainingDir = path.join(GROUPS_DIR, '_training');
  const trainingClaudeMd = path.join(trainingDir, 'formmy-public.md');
  const targetClaudeMd = path.join(groupDir, 'CLAUDE.md');
  try {
    if (
      fs.existsSync(trainingClaudeMd) &&
      (!fs.existsSync(targetClaudeMd) || fs.statSync(targetClaudeMd).size === 0)
    ) {
      fs.copyFileSync(trainingClaudeMd, targetClaudeMd);
    }
    const trainingBin = path.join(trainingDir, 'bin');
    if (fs.existsSync(trainingBin)) {
      const targetBin = path.join(groupDir, 'bin');
      fs.mkdirSync(targetBin, { recursive: true });
      for (const f of fs.readdirSync(trainingBin)) {
        const src = path.join(trainingBin, f);
        const dst = path.join(targetBin, f);
        if (!fs.existsSync(dst)) {
          fs.copyFileSync(src, dst);
          fs.chmodSync(dst, 0o755);
        }
      }
    }
  } catch (err) {
    logger.warn(
      { err, folder },
      '[formmy-whatsapp] failed to seed CLAUDE.md/bin from training',
    );
  }
}

interface InboundMedia {
  type: 'image' | 'sticker' | 'document' | 'audio';
  media_id?: string;
  url?: string;
  media_base64?: string;
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
  private coexistenceReleaseUrl: string | null;
  private integrationId: string | null;
  private opts: ChannelOpts;

  constructor(
    opts: ChannelOpts,
    port: number,
    secret: string,
    callbackUrl: string,
    integrationId: string | null,
    coexistenceReleaseUrl: string | null,
  ) {
    this.opts = opts;
    this.port = port;
    this.secret = secret;
    this.callbackUrl = callbackUrl;
    this.integrationId = integrationId;
    this.coexistenceReleaseUrl = coexistenceReleaseUrl;
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

      if (
        req.method !== 'POST' ||
        (req.url !== '/message' && req.url !== '/trigger-reply')
      ) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      // Auth check (shared by /message and /trigger-reply — same Bearer secret)
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${this.secret}`) {
        res.writeHead(401);
        res.end('Unauthorized');
        return;
      }

      // Operator-initiated wake-up: dashboard "pedir respuesta" button posts
      // here so Sofi/agent gets a chance to react when the customer hasn't
      // sent anything new but state has changed off-band (e.g. price loaded
      // into the catalog DB). Mirrors the manual scheduled_tasks INSERT we
      // used during the 2026-05-13 incident.
      if (req.url === '/trigger-reply') {
        try {
          const body = await readBody(req);
          const parsed = JSON.parse(body);
          const { jid, integration_id, prompt } = parsed as {
            jid?: string;
            integration_id?: string;
            prompt?: string;
          };
          if (!jid) {
            res.writeHead(400);
            res.end('Missing jid');
            return;
          }
          const rawJid = jid.startsWith(JID_PREFIX) ? jid : `${JID_PREFIX}${jid}`;
          const fullJid = canonicalizeJid(rawJid, integration_id);
          const groups = this.opts.registeredGroups();
          const group = groups[fullJid];
          if (!group) {
            res.writeHead(404);
            res.end(`No registered group for jid ${fullJid}`);
            return;
          }
          const now = new Date().toISOString();
          const taskId = `trigger-reply-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}`;
          const promptText =
            (typeof prompt === 'string' && prompt.trim().length > 0
              ? prompt.trim()
              : '[Operador desde dashboard] Retoma esta conversación con el cliente: revisa el último estado, decide si hay algo que comunicar o cerrar, y responde según corresponda.') +
            '\n\nIMPORTANTE: en este canal NADA llega al cliente si no llamas explícitamente a mcp__nanoclaw__send_message. Todo mensaje al cliente debe pasar por ese tool, sin excepción.';
          createTask({
            id: taskId,
            group_folder: group.folder,
            chat_jid: fullJid,
            prompt: promptText,
            schedule_type: 'once',
            schedule_value: '',
            context_mode: 'group',
            next_run: now,
            status: 'active',
            created_at: now,
          });
          logger.info(
            { taskId, jid: fullJid, folder: group.folder },
            '[formmy-whatsapp] Operator trigger-reply queued',
          );
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, taskId, folder: group.folder }));
        } catch (err) {
          logger.error({ err }, '[formmy-whatsapp] trigger-reply failed');
          res.writeHead(500);
          res.end('Internal error');
        }
        return;
      }

      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body);
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
          is_from_me,
          container_config,
          paused_until,
        } = parsed;

        // Diagnostic: surface upstream payloads that the destructuring above
        // would silently drop — generic "[Unsupported" placeholders and any
        // extra fields (`unhandled`, `messageStubType`) Formmy may already be
        // shipping. Fires only on anomalies; lets us deduce the real WhatsApp
        // type without round-tripping with the bridge team.
        if (
          (typeof content === 'string' && content.startsWith('[Unsupported')) ||
          parsed.unhandled !== undefined ||
          parsed.messageStubType !== undefined
        ) {
          logger.warn(
            { payload: parsed },
            '[formmy-whatsapp] non-standard payload from upstream',
          );
        }

        if (!jid || (!content && !media)) {
          res.writeHead(400);
          res.end('Missing jid or content/media');
          return;
        }

        // Canonicalize the JID. Formmy emits two formats today:
        //   legacy → formmy_<phone>@s.whatsapp.net   (customer webhook path)
        //   new    → formmy_<24hex_intId>_<phone>    (echo / coexistence path)
        // Both refer to the same logical conversation, but the chat folder
        // and conversation history live under the legacy key. Without this
        // step, every Operador echo creates a phantom u_<hash> folder and
        // the customer's Claude session never sees what the human said.
        // We normalize to the legacy form when we can confirm the embedded
        // integration_id is known (either matches the payload's
        // `integration_id` or already lives in formmy_jid_mapping). If we
        // can't confirm, we leave the JID untouched so we don't accidentally
        // merge unrelated conversations.
        const rawJid = jid.startsWith(JID_PREFIX) ? jid : `${JID_PREFIX}${jid}`;
        const fullJid = canonicalizeJid(rawJid, integration_id);

        // Resolve group. Two modes:
        //   1. Cache hit on JID → use directly.
        //   2. Cache miss → auto-provision a per-user folder named after the
        //      JID. Each WABA end-user gets isolated CLAUDE.md, attachments,
        //      IPC, .claude/ session.
        //
        // We deliberately do NOT honor the `group_folder` field that the
        // Formmy bridge has historically sent. Folder ownership is a
        // NanoClaw-side concern; letting Formmy declare folder strings
        // leaked our naming convention into the bridge contract and caused
        // the 2026-05-13 incident where 32 chats got mapped to a phantom
        // u_<hash> folder Formmy invented and silently dropped every
        // message (no registered_groups row → "no registered group found").
        // The `formmy_jid_mapping` row is still written so outbound can
        // resolve integration_id, but its group_folder column is no longer
        // authoritative for inbound routing — `getFormmyGroupFolder` is
        // gone from this resolver.
        if (group_folder) {
          logger.warn(
            { jid: fullJid, group_folder },
            '[formmy-whatsapp] explicit group_folder from Formmy is deprecated and ignored — folder ownership stays NanoClaw-side',
          );
        }

        const groups = this.opts.registeredGroups();
        let group: import('../types.js').RegisteredGroup | undefined =
          groups[fullJid];

        if (!group) {
          // sanitizeFolder is defensive; the JID format already matches the
          // group-folder regex, so this is a no-op in practice.
          //
          // Template selection: per-tenant container_config from Formmy
          // (Agent.containerConfig, forwarded by handleChannelMessage) wins
          // when present and well-shaped. Else fall back to the hardcoded
          // FORMMY_PUBLIC_TEMPLATE — every Formmy customer gets the safe
          // default for their first integration, even without explicit
          // per-Agent config.
          const isValidConfig =
            container_config &&
            typeof container_config === 'object' &&
            !Array.isArray(container_config);
          const template = isValidConfig
            ? (container_config as typeof FORMMY_PUBLIC_TEMPLATE)
            : FORMMY_PUBLIC_TEMPLATE;
          const resolvedFolder = sanitizeFolder(fullJid);
          const created = registerFormmyUserGroup(
            fullJid,
            resolvedFolder,
            sender_name || 'WhatsApp User',
            template,
          );
          seedFormmyGroupFiles(resolvedFolder);
          setFormmyJidMapping(fullJid, resolvedFolder, integration_id);
          logger.info(
            { jid: fullJid, folder: resolvedFolder, created },
            '[formmy-whatsapp] Auto-provisioned per-user public group',
          );

          group = Object.values(groups).find(
            (g) => g.folder === resolvedFolder,
          );
          // Cache miss is fine — index.ts:processGroupMessages re-loads from
          // DB when it can't find the JID in the in-memory cache.
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
          // Owner replied from their phone (Meta WABA coexistence): Formmy sets
          // this when the message originated from the business phone, not the
          // API. Keeps the conversation history coherent (operator turns enter
          // as role:assistant via downstream filters in src/index.ts).
          is_from_me: is_from_me === true,
        };

        // Deliver metadata for chat discovery
        this.opts.onChatMetadata(
          fullJid,
          message.timestamp,
          sender_name,
          CHANNEL_NAME,
          false,
        );

        // Sync upstream pause state. Formmy is authoritative — it owns the
        // operator-only handoff timer and knows on every inbound whether the
        // bot should respond. We just mirror that into chats.paused_until so
        // the spawn gate in src/index.ts can short-circuit before any LLM
        // inference runs (saved ~$0.06+ per skipped run on sofi-0).
        //
        // Contract with Formmy webhook forward:
        //   field absent     → backward compat, ignore (older Formmy)
        //   typeof === string → active pause until that ISO timestamp
        //   null             → no pause (operator unpaused or never paused);
        //                      clear any stale flag we may have set earlier
        if (typeof paused_until === 'string' && paused_until.length > 0) {
          setChatPauseUntil(fullJid, paused_until);
        } else if (paused_until === null) {
          clearChatPauseUntil(fullJid);
        }

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
    const buffer = readNonEmptyFile(filePath, 'image');
    await this.postToFormmy({
      phone_number: extractPhone(jid),
      integration_id: this.resolveIntegrationId(jid),
      type: 'image',
      media_base64: buffer.toString('base64'),
      caption,
    });
  }

  async sendSticker(jid: string, filePath: string): Promise<void> {
    const buffer = readNonEmptyFile(filePath, 'sticker');
    await this.postToFormmy({
      phone_number: extractPhone(jid),
      integration_id: this.resolveIntegrationId(jid),
      type: 'sticker',
      media_base64: buffer.toString('base64'),
    });
  }

  async sendDocument(
    jid: string,
    filePath: string,
    filename: string,
    caption: string,
  ): Promise<void> {
    const buffer = readNonEmptyFile(filePath, 'document');
    await this.postToFormmy({
      phone_number: extractPhone(jid),
      integration_id: this.resolveIntegrationId(jid),
      type: 'document',
      media_base64: buffer.toString('base64'),
      filename,
      caption,
    });
  }

  // Outbound voice note. The Formmy bridge accepts type:'audio' as of
  // 2026-05-12 (uploads base64 to Meta /<PHONE_NUMBER_ID>/media then sends
  // {type:'audio', audio:{id:<media_id>}}). The explicit
  // `audio/ogg; codecs=opus` mime hint tells Formmy to render as a native
  // PTT (push-to-talk) bubble; without it the typeFallback ships plain
  // audio/ogg and WhatsApp shows a regular audio attachment instead of the
  // voice-note bubble. ElevenLabs is configured to output opus_48000_64
  // upstream (container/skills-public/voice/text-to-speech), so the file
  // really is opus — no need to transcode.
  async sendAudio(jid: string, filePath: string): Promise<void> {
    const buffer = readNonEmptyFile(filePath, 'audio');
    await this.postToFormmy({
      phone_number: extractPhone(jid),
      integration_id: this.resolveIntegrationId(jid),
      type: 'audio',
      mime_type: 'audio/ogg; codecs=opus',
      media_base64: buffer.toString('base64'),
    });
  }

  // Tentative — pending Formmy bridge confirmation that `type: 'reaction'`
  // is accepted upstream (Meta Cloud API supports message reactions).
  async sendReaction(
    jid: string,
    messageId: string | undefined,
    emoji: string,
  ): Promise<void> {
    if (!messageId) {
      logger.warn(
        { jid, emoji },
        '[formmy-whatsapp] sendReaction requires messageId, skipping',
      );
      return;
    }
    await this.postToFormmy({
      phone_number: extractPhone(jid),
      integration_id: this.resolveIntegrationId(jid),
      type: 'reaction',
      message_id: messageId,
      emoji,
    });
  }

  // Coexistence (Meta WABA): clear the upstream 30-min manual_mode timer for
  // this conversation. The timer lives on the Formmy bridge — we just signal a
  // release. No local pause state is tracked. The endpoint URL must be set
  // explicitly via FORMMY_COEXISTENCE_RELEASE_URL; if absent, this is a no-op
  // that throws so the agent surfaces "feature not configured" to the user.
  async releaseCoexistence(jid: string): Promise<void> {
    if (!this.coexistenceReleaseUrl) {
      throw new Error(
        '[formmy-whatsapp] FORMMY_COEXISTENCE_RELEASE_URL not configured',
      );
    }
    await this.postToFormmy(
      {
        phone_number: extractPhone(jid),
        integration_id: this.resolveIntegrationId(jid),
      },
      this.coexistenceReleaseUrl,
    );
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
    // Formmy bridge delivers media one of two ways:
    //   - `media_base64` inline (small payloads, no extra roundtrip), or
    //   - `media.url` pointing at Formmy's own proxy
    //     (e.g. https://formmy.app/api/v1/integrations/whatsapp/media/<id>?integration_id=<id>),
    //     which fetches from Meta with the integration token on our behalf.
    // Prefer base64 when present; otherwise fetch the proxy URL. We never hit
    // Meta's CDN directly — that would 401 since Formmy holds the token.
    let buffer: Buffer;
    try {
      if (media.media_base64) {
        buffer = Buffer.from(media.media_base64, 'base64');
        if (buffer.length === 0) {
          logger.warn(
            { type: media.type, media_id: media.media_id },
            '[formmy-whatsapp] media_base64 decoded to 0 bytes',
          );
          return (
            existingContent ||
            `[Media: ${media.type} — empty payload from bridge]`
          );
        }
      } else if (media.url) {
        const urlHost = (() => {
          try {
            return new URL(media.url).host;
          } catch {
            return 'invalid';
          }
        })();
        logger.info(
          { type: media.type, media_id: media.media_id, url_host: urlHost },
          '[formmy-whatsapp] fetching media via Formmy proxy URL',
        );
        // The Formmy media proxy requires Bearer auth post-2026-05-12. Only
        // forward our shared secret when the URL host matches the callback
        // host so we don't leak it to arbitrary URLs from a forged payload.
        const callbackHost = (() => {
          try {
            return new URL(this.callbackUrl).host;
          } catch {
            return null;
          }
        })();
        const headers =
          callbackHost && urlHost === callbackHost
            ? { Authorization: `Bearer ${this.secret}` }
            : undefined;
        buffer = await downloadFile(media.url, headers);
        if (buffer.length === 0) {
          logger.warn(
            { type: media.type, media_id: media.media_id, url_host: urlHost },
            '[formmy-whatsapp] proxy fetch returned 0 bytes',
          );
          return (
            existingContent ||
            `[Media: ${media.type} — empty payload from proxy]`
          );
        }
      } else {
        logger.warn(
          { type: media.type, media_id: media.media_id },
          '[formmy-whatsapp] media has neither base64 nor url',
        );
        return (
          existingContent || `[Media: ${media.type} — no payload from bridge]`
        );
      }
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
          const mime = media.mime_type || '';
          const hint = unreadableDocumentHint(mime);
          const docRef = hint
            ? `[Document: attachments/${filename} (${sizeKB}KB, ${mime}) — ${hint}]`
            : `[Document: attachments/${filename} (${sizeKB}KB${mime ? `, ${mime}` : ''})]`;
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

  private async postToFormmy(
    payload: Record<string, unknown>,
    endpointUrl: string = this.callbackUrl,
  ): Promise<void> {
    const data = JSON.stringify(payload);
    const url = new URL(endpointUrl);
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
              // Formmy sometimes returns 200 with the upstream Meta error
              // wrapped in the JSON body instead of propagating Meta's 4xx.
              // Detect that so we don't tell the agent the message was
              // delivered when Meta actually rejected it (e.g. error 132018
              // "Either one of media ID or link must be present" for
              // documents). Treated as non-retryable since the same bytes
              // will produce the same Meta validation error.
              const wrapped = extractWrappedError(body);
              if (wrapped) {
                const err = Object.assign(
                  new Error(
                    `[formmy-whatsapp] Callback 200 with wrapped error for type=${String(payloadType)}: ${wrapped}`,
                  ),
                  { status, retryable: false, body },
                );
                reject(err);
                return;
              }
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

/**
 * Collapse the integration-id-prefixed JID variant onto the legacy form so
 * customer messages and Operador echoes land in the same chat folder.
 *
 *   input  formmy_<24hex>_<phone>   (Formmy echo / coexistence path)
 *   output formmy_<phone>@s.whatsapp.net   (legacy customer-webhook form)
 *
 * Only collapses when the integration_id is verifiably ours — either matches
 * the integration_id from the payload, or is already mapped on this droplet.
 * Unknown integrations are left untouched so a forged or cross-tenant payload
 * can't merge into a real conversation. Legacy JIDs pass through unchanged.
 */
export function canonicalizeJid(
  jid: string,
  payloadIntegrationId: string | undefined,
): string {
  if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us')) return jid;
  const stripped = jid.replace(/^formmy_/, '');
  const parts = stripped.split('_');
  if (parts.length < 2 || !/^[a-f0-9]{24}$/.test(parts[0])) return jid;
  const embeddedIntId = parts[0];
  const phone = parts.slice(1).join('_');
  const isOurs =
    embeddedIntId === payloadIntegrationId ||
    isKnownIntegrationId(embeddedIntId);
  if (!isOurs) return jid;
  return `formmy_${phone}@s.whatsapp.net`;
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

function downloadFile(
  url: string,
  headers?: Record<string, string>,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith('https') ? https : http;
    const opts = headers ? { headers } : {};
    transport
      .get(url, opts, (res) => {
        // Follow redirects (preserving auth header for same-host redirects)
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const sameHost = (() => {
            try {
              return (
                new URL(res.headers.location, url).host === new URL(url).host
              );
            } catch {
              return false;
            }
          })();
          downloadFile(res.headers.location, sameHost ? headers : undefined)
            .then(resolve)
            .catch(reject);
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

// Hint inserted into the inbound document placeholder when the public agent
// has no parser for the format. The agent reads this hint and can prompt the
// user for a supported format instead of asking generic "to what are you
// saying yes". PDFs and plain text are intentionally absent — public template
// can read those via Read tool over /workspace/group/attachments/.
function unreadableDocumentHint(mime: string): string {
  const office = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
    'application/vnd.ms-excel', // xls
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
    'application/msword', // doc
    'application/vnd.openxmlformats-officedocument.presentationml.presentation', // pptx
    'application/vnd.ms-powerpoint', // ppt
  ];
  if (office.includes(mime)) {
    return 'no puedo leer este formato directamente — pedile al usuario que lo mande como PDF o CSV';
  }
  return '';
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
  // Optional: Formmy endpoint to release the WABA coexistence (manual_mode)
  // timer for a given conversation. When unset, the clear_coexistence_pause
  // tool returns a clear "not configured" error instead of silently failing.
  const coexistenceReleaseUrl =
    process.env.FORMMY_COEXISTENCE_RELEASE_URL || null;

  if (!secret || !callbackUrl) {
    return null; // Credentials missing -- skip
  }

  return new FormmyWhatsAppChannel(
    opts,
    port,
    secret,
    callbackUrl,
    integrationId,
    coexistenceReleaseUrl,
  );
});
