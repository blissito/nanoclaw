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

import { GROUPS_DIR } from '../config.js';
import { getFormmyGroupFolder, setFormmyJidMapping } from '../db.js';
import { logger } from '../logger.js';
import { Channel, NewMessage } from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const CHANNEL_NAME = 'formmy-whatsapp';
const JID_PREFIX = 'formmy_';
const DEFAULT_GROUP = process.env.FORMMY_DEFAULT_GROUP || '';

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
  private integrationId: string;
  private opts: ChannelOpts;

  constructor(
    opts: ChannelOpts,
    port: number,
    secret: string,
    callbackUrl: string,
    integrationId: string,
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
        const { jid, sender, sender_name, content, message_id, media, group_folder } =
          JSON.parse(body);

        if (!jid || (!content && !media)) {
          res.writeHead(400);
          res.end('Missing jid or content/media');
          return;
        }

        const fullJid = jid.startsWith(JID_PREFIX)
          ? jid
          : `${JID_PREFIX}${jid}`;

        // Resolve group via mapping table
        const groups = this.opts.registeredGroups();
        let group: import('../types.js').RegisteredGroup | undefined = groups[fullJid];
        const targetFolder = group_folder || DEFAULT_GROUP;

        if (!group && targetFolder) {
          // Check if JID already has a mapping
          const existingFolder = getFormmyGroupFolder(fullJid);

          if (!existingFolder) {
            // New JID — create mapping
            setFormmyJidMapping(fullJid, targetFolder);
            logger.info(
              { jid: fullJid, folder: targetFolder },
              '[formmy-whatsapp] Mapped new JID to group',
            );
          } else if (group_folder && existingFolder !== group_folder) {
            // JID exists but group_folder changed (e.g. moving from lobby)
            setFormmyJidMapping(fullJid, group_folder);
            logger.info(
              { jid: fullJid, from: existingFolder, to: group_folder },
              '[formmy-whatsapp] Moved JID to new group',
            );
          }

          // Resolve group from registered_groups by folder
          const resolvedFolder = group_folder || existingFolder || targetFolder;
          group = Object.values(groups).find(
            (g) => g.folder === resolvedFolder,
          );
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

  async sendMessage(jid: string, text: string): Promise<void> {
    await this.postToFormmy({
      phone_number: extractPhone(jid),
      integration_id: this.integrationId,
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
      integration_id: this.integrationId,
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
      integration_id: this.integrationId,
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
      integration_id: this.integrationId,
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
    try {
      const data = JSON.stringify(payload);
      const url = new URL(this.callbackUrl);
      const isHttps = url.protocol === 'https:';
      const transport = isHttps ? https : http;

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
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 400) {
            logger.warn(
              { status: res.statusCode, type: payload.type },
              '[formmy-whatsapp] Callback failed',
            );
          }
        },
      );

      req.on('error', (err) => {
        logger.error(
          { err, type: payload.type },
          '[formmy-whatsapp] Callback request error',
        );
      });

      req.write(data);
      req.end();
    } catch (err) {
      logger.error(
        { err, type: payload.type },
        '[formmy-whatsapp] Failed to send outbound',
      );
    }
  }
}

function extractPhone(jid: string): string {
  return jid.replace('formmy_', '');
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
  const integrationId = process.env.FORMMY_INTEGRATION_ID;

  if (!secret || !callbackUrl || !integrationId) {
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
