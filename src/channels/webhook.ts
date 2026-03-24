/**
 * Webhook Channel — Generic HTTP channel for external platforms.
 *
 * Convention: any platform (Formmy, custom dashboards, etc.) can connect
 * to Nanoclaw by POSTing messages to a local HTTP endpoint and receiving
 * responses via a callback URL.
 *
 * ENV:
 *   WEBHOOK_CHANNEL_PORT    — Port for inbound HTTP server (default: 3939)
 *   WEBHOOK_CHANNEL_SECRET  — Shared secret for auth (required)
 *   WEBHOOK_CALLBACK_URL    — URL to POST responses back (required)
 *
 * Inbound (platform → Nanoclaw):
 *   POST http://localhost:{port}/message
 *   Headers: { Authorization: Bearer {secret} }
 *   Body: { jid: string, sender: string, sender_name: string, content: string }
 *
 * Outbound (Nanoclaw → platform):
 *   POST {callback_url}
 *   Headers: { Authorization: Bearer {secret} }
 *   Body: { jid: string, text: string }
 *
 * JID convention: "webhook_{platform}_{id}" (e.g., "webhook_formmy_user123")
 */
import http from 'http';
import { Channel, NewMessage } from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { logger } from '../logger.js';

const CHANNEL_NAME = 'webhook';
const JID_PREFIX = 'webhook_';

export class WebhookChannel implements Channel {
  name = CHANNEL_NAME;

  private server: http.Server | null = null;
  private connected = false;
  private port: number;
  private secret: string;
  private callbackUrl: string;
  private opts: ChannelOpts;

  constructor(
    opts: ChannelOpts,
    port: number,
    secret: string,
    callbackUrl: string,
  ) {
    this.opts = opts;
    this.port = port;
    this.secret = secret;
    this.callbackUrl = callbackUrl;
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
        const { jid, sender, sender_name, content } = JSON.parse(body);

        if (!jid || !content) {
          res.writeHead(400);
          res.end('Missing jid or content');
          return;
        }

        const fullJid = jid.startsWith(JID_PREFIX)
          ? jid
          : `${JID_PREFIX}${jid}`;

        const message: NewMessage = {
          id: `wh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          chat_jid: fullJid,
          sender: sender || fullJid,
          sender_name: sender_name || 'Webhook User',
          content,
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

        // Deliver message to Nanoclaw message loop
        this.opts.onMessage(fullJid, message);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: message.id }));
      } catch (err) {
        logger.error({ err }, '[webhook] Failed to process inbound message');
        res.writeHead(500);
        res.end('Internal error');
      }
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, () => {
        this.connected = true;
        logger.info({ port: this.port }, '[webhook] Channel listening');
        resolve();
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    try {
      const payload = JSON.stringify({ jid, text });
      const url = new URL(this.callbackUrl);

      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            Authorization: `Bearer ${this.secret}`,
          },
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 400) {
            logger.warn(
              { status: res.statusCode, jid },
              '[webhook] Callback failed',
            );
          }
        },
      );

      req.on('error', (err) => {
        logger.error({ err, jid }, '[webhook] Callback request error');
      });

      req.write(payload);
      req.end();
    } catch (err) {
      logger.error({ err, jid }, '[webhook] Failed to send outbound message');
    }
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
    logger.info('[webhook] Channel disconnected');
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Self-register
registerChannel(CHANNEL_NAME, (opts: ChannelOpts) => {
  const port = parseInt(process.env.WEBHOOK_CHANNEL_PORT || '3939', 10);
  const secret = process.env.WEBHOOK_CHANNEL_SECRET;
  const callbackUrl = process.env.WEBHOOK_CALLBACK_URL;

  if (!secret || !callbackUrl) {
    return null; // Credentials missing — skip
  }

  return new WebhookChannel(opts, port, secret, callbackUrl);
});
