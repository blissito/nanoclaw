/**
 * Nanoclaw Admin API
 *
 * Minimal HTTP server exposing per-group config to ghosty.studio.
 * Reads/writes the same SQLite store that the main nanoclaw daemon uses,
 * so changes apply on the next container spawn — no restart required.
 *
 * Run standalone: `tsx src/admin-api.ts`
 * Env:
 *   NANOCLAW_ADMIN_TOKEN  (required) — Bearer token for all requests
 *   NANOCLAW_ADMIN_PORT   (default 8787)
 *   NANOCLAW_ADMIN_HOST   (default 127.0.0.1 — set to 0.0.0.0 or VPC IP to expose)
 *   NANOCLAW_GROUPS_DIR   (default ./groups)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  getAllRegisteredGroups,
  setRegisteredGroup,
  initDatabase,
} from './db.js';
import type { RegisteredGroup, ContainerConfig } from './types.js';

const TOKEN = process.env.NANOCLAW_ADMIN_TOKEN;
const PORT = Number(process.env.NANOCLAW_ADMIN_PORT ?? 8787);
const HOST = process.env.NANOCLAW_ADMIN_HOST ?? '127.0.0.1';
const GROUPS_DIR = process.env.NANOCLAW_GROUPS_DIR ?? path.resolve('groups');

if (!TOKEN) {
  console.error('[admin-api] NANOCLAW_ADMIN_TOKEN is required');
  process.exit(1);
}

initDatabase();

type Json =
  | Record<string, unknown>
  | unknown[]
  | string
  | number
  | boolean
  | null;

function send(res: http.ServerResponse, status: number, body: Json) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function auth(req: http.IncomingMessage): boolean {
  const h = req.headers.authorization ?? '';
  return h === `Bearer ${TOKEN}`;
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      if (!s) return resolve({});
      try {
        resolve(JSON.parse(s));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function publicGroup(jid: string, g: RegisteredGroup) {
  return {
    jid,
    name: g.name,
    folder: g.folder,
    trigger: g.trigger,
    requiresTrigger: g.requiresTrigger ?? true,
    isMain: g.isMain ?? false,
    mcpServers: g.containerConfig?.mcpServers ?? null,
    addedAt: g.added_at,
  };
}

function claudeMdPath(folder: string): string {
  return path.join(GROUPS_DIR, folder, 'CLAUDE.md');
}

function readClaudeMd(folder: string): string | null {
  const p = claudeMdPath(folder);
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function writeClaudeMd(folder: string, content: string) {
  const p = claudeMdPath(folder);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

const STORE_DB_PATH =
  process.env.NANOCLAW_STORE_DB ?? path.resolve('store/messages.db');

function activityFor(jid: string) {
  let db: any;
  try {
    db = new Database(STORE_DB_PATH, { readonly: true, fileMustExist: true });
    const last = db
      .prepare(
        `SELECT sender_name, content, timestamp, is_from_me, is_bot_message
         FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT 1`,
      )
      .get(jid) as
      | {
          sender_name: string;
          content: string;
          timestamp: string;
          is_from_me: number;
          is_bot_message: number;
        }
      | undefined;
    const lastBot = db
      .prepare(
        `SELECT content, timestamp FROM messages
         WHERE chat_jid = ? AND is_bot_message = 1
         ORDER BY timestamp DESC LIMIT 1`,
      )
      .get(jid) as { content: string; timestamp: string } | undefined;
    const since24 = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const since7d = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const count24h = (
      db
        .prepare(
          `SELECT COUNT(*) as c FROM messages WHERE chat_jid = ? AND timestamp > ?`,
        )
        .get(jid, since24) as { c: number }
    ).c;
    const count7d = (
      db
        .prepare(
          `SELECT COUNT(*) as c FROM messages WHERE chat_jid = ? AND timestamp > ?`,
        )
        .get(jid, since7d) as { c: number }
    ).c;
    // Recent timeline for preview
    const recent = db
      .prepare(
        `SELECT id, sender_name, content, timestamp, is_from_me, is_bot_message
         FROM messages WHERE chat_jid = ?
         ORDER BY timestamp DESC LIMIT 20`,
      )
      .all(jid) as Array<{
      id: string;
      sender_name: string;
      content: string;
      timestamp: string;
      is_from_me: number;
      is_bot_message: number;
    }>;
    return {
      lastMessageAt: last?.timestamp ?? null,
      lastMessage: last
        ? {
            senderName: last.sender_name,
            content: (last.content ?? '').slice(0, 200),
            isFromBot: !!last.is_bot_message,
            isFromMe: !!last.is_from_me,
          }
        : null,
      lastBotReply: lastBot
        ? {
            content: (lastBot.content ?? '').slice(0, 200),
            timestamp: lastBot.timestamp,
          }
        : null,
      messagesLast24h: count24h,
      messagesLast7d: count7d,
      recent: recent.reverse().map((m) => ({
        id: m.id,
        senderName: m.sender_name,
        content: (m.content ?? '').slice(0, 500),
        timestamp: m.timestamp,
        isFromBot: !!m.is_bot_message,
        isFromMe: !!m.is_from_me,
      })),
    };
  } catch (e: any) {
    return { error: String(e?.message ?? e) };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

function tailLogs(folder: string, lines: number): string {
  const dir = path.join(GROUPS_DIR, folder, 'logs');
  if (!fs.existsSync(dir)) return '';
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.log') || f.endsWith('.txt'))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (files.length === 0) return '';
  const content = fs.readFileSync(path.join(dir, files[0].f), 'utf8');
  const arr = content.split('\n');
  return arr.slice(-lines).join('\n');
}

const server = http.createServer(async (req, res) => {
  try {
    if (!auth(req)) return send(res, 401, { error: 'unauthorized' });

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const method = req.method ?? 'GET';
    const parts = url.pathname.split('/').filter(Boolean); // ['admin','agents', ...]

    // GET /admin/agents
    if (
      method === 'GET' &&
      parts[0] === 'admin' &&
      parts[1] === 'agents' &&
      parts.length === 2
    ) {
      const groups = getAllRegisteredGroups();
      return send(
        res,
        200,
        Object.entries(groups).map(([jid, g]) => publicGroup(jid, g)),
      );
    }

    // GET /admin/agents/:jid
    if (
      method === 'GET' &&
      parts[0] === 'admin' &&
      parts[1] === 'agents' &&
      parts.length === 3
    ) {
      const jid = decodeURIComponent(parts[2]);
      const g = getAllRegisteredGroups()[jid];
      if (!g) return send(res, 404, { error: 'not_found' });
      return send(res, 200, {
        ...publicGroup(jid, g),
        containerConfig: g.containerConfig ?? null,
        claudeMd: readClaudeMd(g.folder),
      });
    }

    // GET /admin/agents/:jid/activity
    if (
      method === 'GET' &&
      parts[0] === 'admin' &&
      parts[1] === 'agents' &&
      parts[3] === 'activity' &&
      parts.length === 4
    ) {
      const jid = decodeURIComponent(parts[2]);
      const g = getAllRegisteredGroups()[jid];
      if (!g) return send(res, 404, { error: 'not_found' });
      return send(res, 200, activityFor(jid));
    }

    // GET /admin/agents/:jid/logs?tail=200
    if (
      method === 'GET' &&
      parts[0] === 'admin' &&
      parts[1] === 'agents' &&
      parts[3] === 'logs' &&
      parts.length === 4
    ) {
      const jid = decodeURIComponent(parts[2]);
      const g = getAllRegisteredGroups()[jid];
      if (!g) return send(res, 404, { error: 'not_found' });
      const tail = Math.min(Number(url.searchParams.get('tail') ?? 200), 2000);
      return send(res, 200, { logs: tailLogs(g.folder, tail) });
    }

    // PATCH /admin/agents/:jid
    if (
      method === 'PATCH' &&
      parts[0] === 'admin' &&
      parts[1] === 'agents' &&
      parts.length === 3
    ) {
      const jid = decodeURIComponent(parts[2]);
      const g = getAllRegisteredGroups()[jid];
      if (!g) return send(res, 404, { error: 'not_found' });
      const body = await readBody(req);

      const next: RegisteredGroup = { ...g };
      if (typeof body.trigger === 'string') next.trigger = body.trigger;
      if (typeof body.requiresTrigger === 'boolean')
        next.requiresTrigger = body.requiresTrigger;
      if (typeof body.name === 'string') next.name = body.name;
      if (Array.isArray(body.mcpServers)) {
        const cc: ContainerConfig = { ...(g.containerConfig ?? {}) };
        cc.mcpServers = body.mcpServers.filter(
          (x: unknown) => typeof x === 'string',
        );
        next.containerConfig = cc;
      }
      setRegisteredGroup(jid, next);

      if (typeof body.claudeMd === 'string') {
        writeClaudeMd(next.folder, body.claudeMd);
      }

      const fresh = getAllRegisteredGroups()[jid]!;
      return send(res, 200, {
        ...publicGroup(jid, fresh),
        containerConfig: fresh.containerConfig ?? null,
        claudeMd: readClaudeMd(fresh.folder),
      });
    }

    return send(res, 404, { error: 'route_not_found' });
  } catch (err) {
    console.error('[admin-api] error', err);
    send(res, 500, { error: 'internal', detail: String(err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[admin-api] listening on http://${HOST}:${PORT}`);
});
