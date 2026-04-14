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

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

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
    if (method === 'GET' && parts[0] === 'admin' && parts[1] === 'agents' && parts.length === 2) {
      const groups = getAllRegisteredGroups();
      return send(res, 200, Object.entries(groups).map(([jid, g]) => publicGroup(jid, g)));
    }

    // GET /admin/agents/:jid
    if (method === 'GET' && parts[0] === 'admin' && parts[1] === 'agents' && parts.length === 3) {
      const jid = decodeURIComponent(parts[2]);
      const g = getAllRegisteredGroups()[jid];
      if (!g) return send(res, 404, { error: 'not_found' });
      return send(res, 200, {
        ...publicGroup(jid, g),
        containerConfig: g.containerConfig ?? null,
        claudeMd: readClaudeMd(g.folder),
      });
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
    if (method === 'PATCH' && parts[0] === 'admin' && parts[1] === 'agents' && parts.length === 3) {
      const jid = decodeURIComponent(parts[2]);
      const g = getAllRegisteredGroups()[jid];
      if (!g) return send(res, 404, { error: 'not_found' });
      const body = await readBody(req);

      const next: RegisteredGroup = { ...g };
      if (typeof body.trigger === 'string') next.trigger = body.trigger;
      if (typeof body.requiresTrigger === 'boolean') next.requiresTrigger = body.requiresTrigger;
      if (typeof body.name === 'string') next.name = body.name;
      if (Array.isArray(body.mcpServers)) {
        const cc: ContainerConfig = { ...(g.containerConfig ?? {}) };
        cc.mcpServers = body.mcpServers.filter((x: unknown) => typeof x === 'string');
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
