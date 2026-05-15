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
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
  getAllRegisteredGroups,
  setRegisteredGroup,
  initDatabase,
  getFormmyJidsByIntegrationId,
  deleteFormmyJidMapping,
  deleteRegisteredGroup,
  deleteSession,
  deleteMessagesByChatJid,
  getRegisteredGroupByFolder,
} from './db.js';

const execFileAsync = promisify(execFile);
import type { RegisteredGroup, ContainerConfig } from './types.js';
import { CREDENTIAL_PROXY_PORT } from './config.js';
import { runContainerAgent, type ContainerOutput } from './container-runner.js';

const TOKEN = process.env.NANOCLAW_ADMIN_TOKEN;
const PORT = Number(process.env.NANOCLAW_ADMIN_PORT ?? 8787);
const HOST = process.env.NANOCLAW_ADMIN_HOST ?? '127.0.0.1';
const GROUPS_DIR = process.env.NANOCLAW_GROUPS_DIR ?? path.resolve('groups');
// The credential-proxy (running inside the main nanoclaw daemon) exposes
// /nanoclaw/create-group + /nanoclaw/invite-link on this port. On Linux it
// binds to docker0; on macOS dev to 127.0.0.1. Override via env if needed.
const CREDENTIAL_PROXY_HOST =
  process.env.NANOCLAW_PROXY_INTERNAL_HOST ?? '127.0.0.1';
const PROXY_BASE = `http://${CREDENTIAL_PROXY_HOST}:${CREDENTIAL_PROXY_PORT}`;

if (!TOKEN) {
  console.error('[admin-api] NANOCLAW_ADMIN_TOKEN is required');
  process.exit(1);
}

initDatabase();

// Resolved once at startup so /admin/channel-info responds without forking.
const CHANNEL_INFO_VERSION: string = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.resolve('package.json'), 'utf8'),
      ) as { version?: string };
      return pkg.version ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }
})();

function secretFingerprint(secret: string | undefined): string | null {
  if (!secret) return null;
  const hex = crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
  return `sha256:${hex.slice(0, 12)}`;
}

// Best-effort local teardown of a single group: kill its container, drop its
// SQLite rows (registered_groups, sessions, messages, chats, formmy mapping),
// and remove its on-disk folders. Each step is independent so a partial
// failure doesn't abort the rest — collected errors are returned for the
// caller to surface.
async function cleanupGroupLocally(
  jid: string,
  folder: string,
): Promise<string[]> {
  const errs: string[] = [];
  const DATA_DIR = process.env.NANOCLAW_DATA_DIR ?? path.resolve('data');
  try {
    await execFileAsync('sh', [
      '-c',
      `docker ps --format '{{.Names}}' | grep '^nanoclaw-${folder}-' | xargs -r docker kill`,
    ]);
  } catch (err) {
    errs.push(`docker_kill: ${String(err).slice(0, 100)}`);
  }
  try {
    deleteMessagesByChatJid(jid);
  } catch (err) {
    errs.push(`delete_messages: ${String(err).slice(0, 100)}`);
  }
  try {
    deleteSession(folder);
  } catch (err) {
    errs.push(`delete_session: ${String(err).slice(0, 100)}`);
  }
  try {
    deleteRegisteredGroup(jid);
  } catch (err) {
    errs.push(`delete_registered_group: ${String(err).slice(0, 100)}`);
  }
  try {
    deleteFormmyJidMapping(jid);
  } catch (err) {
    errs.push(`delete_formmy_jid_mapping: ${String(err).slice(0, 100)}`);
  }
  // rm -rf is intentional — these dirs are scoped to a single tenant's folder
  // and disappearing them is the whole point.
  try {
    fs.rmSync(path.join(GROUPS_DIR, folder), { recursive: true, force: true });
  } catch (err) {
    errs.push(`rm_groups_dir: ${String(err).slice(0, 100)}`);
  }
  try {
    fs.rmSync(path.join(DATA_DIR, 'sessions', folder), {
      recursive: true,
      force: true,
    });
  } catch (err) {
    errs.push(`rm_sessions_dir: ${String(err).slice(0, 100)}`);
  }
  return errs;
}

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

    // GET /admin/channel-info
    // Lets a pairing UI (e.g. Formmy panel) discover where to POST inbound
    // forwards without the operator hand-copying port + secret. The secret
    // itself is never returned; only a sha256:<12 hex> fingerprint so the
    // caller can verify it holds the matching secret locally.
    if (
      method === 'GET' &&
      parts[0] === 'admin' &&
      parts[1] === 'channel-info' &&
      parts.length === 2
    ) {
      return send(res, 200, {
        channel: 'formmy-whatsapp',
        port: Number(process.env.FORMMY_CHANNEL_PORT ?? 3940),
        secretFingerprint: secretFingerprint(process.env.FORMMY_CHANNEL_SECRET),
        version: CHANNEL_INFO_VERSION,
      });
    }

    // POST /admin/channel-info/test-secret  body: { secret }
    // Companion to the discovery endpoint: the caller submits the secret it
    // believes matches, we compare in constant time against our own, and
    // return { match }. Used by "Probar conexión" UI flows.
    if (
      method === 'POST' &&
      parts[0] === 'admin' &&
      parts[1] === 'channel-info' &&
      parts[2] === 'test-secret' &&
      parts.length === 3
    ) {
      const body = await readBody(req);
      const candidate = typeof body.secret === 'string' ? body.secret : '';
      const expected = process.env.FORMMY_CHANNEL_SECRET ?? '';
      if (!candidate || !expected) {
        return send(res, 200, { match: false });
      }
      const a = crypto.createHash('sha256').update(candidate, 'utf8').digest();
      const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
      const match = a.length === b.length && crypto.timingSafeEqual(a, b);
      return send(res, 200, { match });
    }

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
      const ccPatch: ContainerConfig = { ...(g.containerConfig ?? {}) };
      let ccTouched = false;
      if (Array.isArray(body.mcpServers)) {
        ccPatch.mcpServers = body.mcpServers.filter(
          (x: unknown) => typeof x === 'string',
        );
        ccTouched = true;
      }
      if (Array.isArray(body.allowedTools)) {
        ccPatch.allowedTools = body.allowedTools.filter(
          (x: unknown) => typeof x === 'string',
        );
        ccTouched = true;
      }
      if (body.env && typeof body.env === 'object') {
        const merged = { ...(ccPatch.env ?? {}) };
        for (const [k, v] of Object.entries(body.env)) {
          if (typeof v === 'string') merged[k] = v;
        }
        ccPatch.env = merged;
        ccTouched = true;
      }
      if (body.profile === 'public' || body.profile === 'admin') {
        ccPatch.profile = body.profile;
        ccTouched = true;
      }
      if (ccTouched) next.containerConfig = ccPatch;
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

    // POST /admin/agents
    // Creates a new WhatsApp group and registers the bot as admin.
    // Body: { name: string }
    // Response: { jid, name, invite_link, ...publicGroup }
    if (
      method === 'POST' &&
      parts[0] === 'admin' &&
      parts[1] === 'agents' &&
      parts.length === 2
    ) {
      const body = await readBody(req);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) return send(res, 400, { error: 'name_required' });

      let proxyResp: Response;
      try {
        proxyResp = await fetch(`${PROXY_BASE}/nanoclaw/create-group`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name }),
        });
      } catch (err) {
        return send(res, 503, {
          error: 'credential_proxy_unreachable',
          detail: String(err),
        });
      }
      const proxyText = await proxyResp.text();
      if (!proxyResp.ok) {
        return send(res, 502, {
          error: 'create_group_failed',
          detail: proxyText,
        });
      }
      let result: { jid?: string; inviteLink?: string | null };
      try {
        result = JSON.parse(proxyText);
      } catch {
        return send(res, 502, {
          error: 'invalid_proxy_response',
          detail: proxyText,
        });
      }
      if (!result.jid) {
        return send(res, 502, {
          error: 'no_jid_in_response',
          detail: proxyText,
        });
      }

      const g = getAllRegisteredGroups()[result.jid];
      return send(res, 200, {
        ...(g ? publicGroup(result.jid, g) : { jid: result.jid, name }),
        invite_link: result.inviteLink ?? null,
      });
    }

    // GET /admin/agents/:jid/invite-link
    if (
      method === 'GET' &&
      parts[0] === 'admin' &&
      parts[1] === 'agents' &&
      parts[3] === 'invite-link' &&
      parts.length === 4
    ) {
      const jid = decodeURIComponent(parts[2]);
      const g = getAllRegisteredGroups()[jid];
      if (!g) return send(res, 404, { error: 'not_found' });
      let proxyResp: Response;
      try {
        proxyResp = await fetch(
          `${PROXY_BASE}/nanoclaw/invite-link?jid=${encodeURIComponent(jid)}`,
        );
      } catch (err) {
        return send(res, 503, {
          error: 'credential_proxy_unreachable',
          detail: String(err),
        });
      }
      const proxyText = await proxyResp.text();
      if (!proxyResp.ok) {
        return send(res, 502, {
          error: 'invite_link_failed',
          detail: proxyText,
        });
      }
      let result: { link?: string | null };
      try {
        result = JSON.parse(proxyText);
      } catch {
        return send(res, 502, {
          error: 'invalid_proxy_response',
          detail: proxyText,
        });
      }
      return send(res, 200, { invite_link: result.link ?? null });
    }

    // DELETE /admin/agents/:jid
    // Tear down a single registered agent: ask Baileys to leave the WA group
    // (best-effort), then run local cleanup (containers, SQLite, on-disk).
    // Body (optional): { leaveGroup?: boolean }  default true. Set false when
    // the operator already removed the bot manually from WhatsApp.
    // Response: { ok, jid, folder, leftGroup, leaveGroupError, localCleanup }.
    if (
      method === 'DELETE' &&
      parts[0] === 'admin' &&
      parts[1] === 'agents' &&
      parts.length === 3
    ) {
      const jid = decodeURIComponent(parts[2]);
      const g = getAllRegisteredGroups()[jid];
      if (!g) return send(res, 404, { error: 'not_found' });
      const body = await readBody(req);
      const shouldLeave = body.leaveGroup !== false;

      let leftGroup = false;
      let leaveGroupError: string | null = null;
      if (shouldLeave) {
        try {
          const proxyResp = await fetch(`${PROXY_BASE}/nanoclaw/leave-group`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jid }),
          });
          if (proxyResp.ok) {
            leftGroup = true;
          } else {
            leaveGroupError = `proxy_${proxyResp.status}: ${(
              await proxyResp.text()
            ).slice(0, 200)}`;
          }
        } catch (err) {
          leaveGroupError = `credential_proxy_unreachable: ${String(err).slice(
            0,
            200,
          )}`;
        }
      }

      const localErrors = await cleanupGroupLocally(jid, g.folder);
      return send(res, 200, {
        ok: true,
        jid,
        folder: g.folder,
        leftGroup,
        leaveGroupError,
        localCleanup: { errors: localErrors },
      });
    }

    // GET /admin/skills
    // Lista los skills instalados en .claude/skills/ del primer grupo
    // registrado (single-agent VMs ghostyclaw). Parsea frontmatter mínimo
    // de SKILL.md (name, description). Source of truth para la UI.
    if (
      method === 'GET' &&
      parts[0] === 'admin' &&
      parts[1] === 'skills' &&
      parts.length === 2
    ) {
      const dataDir = process.env.NANOCLAW_DATA_DIR ?? path.resolve('data');
      const skills: Array<{
        name: string;
        description: string;
        files: string[];
        sizeBytes: number;
        uploadedAt: string;
      }> = [];
      const groups = Object.entries(getAllRegisteredGroups());
      for (const [, group] of groups) {
        const skillsDir = path.join(
          dataDir,
          'sessions',
          group.folder,
          '.claude',
          'skills',
        );
        if (!fs.existsSync(skillsDir)) continue;
        for (const name of fs.readdirSync(skillsDir)) {
          const skillDir = path.join(skillsDir, name);
          let st: fs.Stats;
          try {
            st = fs.statSync(skillDir);
          } catch {
            continue;
          }
          if (!st.isDirectory()) continue;
          const mdPath = path.join(skillDir, 'SKILL.md');
          let description = '';
          let md = '';
          try {
            md = fs.readFileSync(mdPath, 'utf8');
          } catch {
            continue;
          }
          const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
          if (fm) {
            const descMatch = fm[1].match(/^description:\s*(.+)$/m);
            if (descMatch) description = descMatch[1].trim().replace(/^["']|["']$/g, '');
          }
          let files: string[] = [];
          let sizeBytes = 0;
          try {
            files = fs.readdirSync(skillDir);
            for (const f of files) {
              try {
                sizeBytes += fs.statSync(path.join(skillDir, f)).size;
              } catch {
                /* ignore */
              }
            }
          } catch {
            /* ignore */
          }
          skills.push({
            name,
            description,
            files,
            sizeBytes,
            uploadedAt: st.mtime.toISOString(),
          });
        }
        // Solo el primer grupo — ghostyclaw VMs son single-agent.
        break;
      }
      return send(res, 200, { skills });
    }

    // POST /admin/skills/install
    // Body: { name: string, path: string, files: string[] }
    //
    // EasyBits ya escribió SKILL.md + assets en `path` (e.g. /skills/<name>/)
    // vía sandbox-agent. Aquí los mudamos al path canónico de Claude para
    // cada grupo registrado: <DATA_DIR>/sessions/<folder>/.claude/skills/<name>/.
    // El siguiente query() del SDK los descubre — no hace falta hot-reload.
    if (
      method === 'POST' &&
      parts[0] === 'admin' &&
      parts[1] === 'skills' &&
      parts[2] === 'install' &&
      parts.length === 3
    ) {
      const body = await readBody(req);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const srcPath = typeof body.path === 'string' ? body.path : '';
      const files = Array.isArray(body.files) ? body.files : [];
      if (!name || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
        return send(res, 400, { error: 'invalid_name' });
      }
      if (!srcPath.startsWith('/skills/')) {
        return send(res, 400, { error: 'invalid_source_path' });
      }
      if (!fs.existsSync(srcPath)) {
        return send(res, 404, { error: 'source_dir_missing', detail: srcPath });
      }
      const dataDir = process.env.NANOCLAW_DATA_DIR ?? path.resolve('data');
      const groups = Object.entries(getAllRegisteredGroups());
      const copied: string[] = [];
      const failed: Array<{ folder: string; error: string }> = [];
      for (const [, group] of groups) {
        const dstDir = path.join(
          dataDir,
          'sessions',
          group.folder,
          '.claude',
          'skills',
          name,
        );
        try {
          fs.rmSync(dstDir, { recursive: true, force: true });
          fs.mkdirSync(path.dirname(dstDir), { recursive: true });
          fs.cpSync(srcPath, dstDir, { recursive: true });
          copied.push(group.folder);
        } catch (err: any) {
          failed.push({
            folder: group.folder,
            error: String(err).slice(0, 200),
          });
        }
      }
      // Cleanup source — el skill ahora vive en cada `.claude/skills/<name>/`.
      // Si no había grupos registrados (VM recién booteada sin agente activo),
      // el cleanup deja `/skills/` listo para el próximo install y no rompe nada.
      try {
        fs.rmSync(srcPath, { recursive: true, force: true });
      } catch {
        // best-effort; el siguiente install sobrescribe.
      }
      return send(res, 200, {
        ok: true,
        name,
        copied_to: copied,
        files,
        failed: failed.length > 0 ? failed : undefined,
      });
    }

    // POST /admin/integration/:id/cleanup
    // Tear down every formmy_<jid> group registered against this integration_id:
    // kill containers, drop SQLite rows (registered_groups, sessions, messages,
    // formmy_jid_mapping), and remove on-disk folders (groups/, data/sessions/).
    // Called by formmy.app's disconnect flow so a re-pair starts clean.
    if (
      method === 'POST' &&
      parts[0] === 'admin' &&
      parts[1] === 'integration' &&
      parts[3] === 'cleanup' &&
      parts.length === 4
    ) {
      const integrationId = decodeURIComponent(parts[2]);
      const mappings = getFormmyJidsByIntegrationId(integrationId);
      if (mappings.length === 0) {
        return send(res, 200, {
          ok: true,
          cleaned: 0,
          message:
            'No groups found for this integration_id (nothing to clean).',
        });
      }
      const cleaned: Array<{
        jid: string;
        folder: string;
        errors: string[];
      }> = [];
      for (const { jid, group_folder } of mappings) {
        const errors = await cleanupGroupLocally(jid, group_folder);
        cleaned.push({ jid, folder: group_folder, errors });
      }
      return send(res, 200, {
        ok: true,
        cleaned: cleaned.length,
        details: cleaned,
      });
    }

    // GET /chat/ready
    // Readiness probe for the web chat endpoint. Returns 200 {ready:true}
    // only when both prerequisites are met:
    //   1. Docker daemon responds to `docker info`
    //   2. The agent container image (nanoclaw-agent:latest) exists locally
    // The wrapper builds the agent image in background on first boot (~5min);
    // until then, /chat would fail with "image not found". Easybits polls
    // this endpoint and only transitions Agent.status="building" → "running"
    // when ready, so the UI input stays disabled while we boot.
    if (
      method === 'GET' &&
      parts[0] === 'chat' &&
      parts[1] === 'ready' &&
      parts.length === 2
    ) {
      try {
        await execFileAsync(
          'docker',
          ['info', '--format', '{{.ServerVersion}}'],
          { timeout: 3000 },
        );
      } catch (err) {
        return send(res, 200, { ready: false, reason: 'docker_not_ready' });
      }
      try {
        await execFileAsync(
          'docker',
          ['image', 'inspect', 'nanoclaw-agent:latest'],
          { timeout: 3000 },
        );
      } catch (err) {
        return send(res, 200, { ready: false, reason: 'agent_image_building' });
      }
      return send(res, 200, { ready: true });
    }

    // POST /chat
    // SSE chat endpoint for the ghosty.studio web widget (consumed via the
    // sandbox-host proxy /v1/sandbox/{id}/agent/message). Auth: Bearer
    // NANOCLAW_ADMIN_TOKEN (same as the rest of admin-api).
    //
    // Body: { content: string, sessionId?: string }
    // Stream: SSE events `{type:"chunk",value:"..."}` then `{type:"done"}`.
    //
    // The web channel maps to a single shared virtual group with folder
    // "web". Per-conversation isolation comes from `sessionId` (Claude SDK
    // resume), not from per-user groups — keeps the channel model symmetrical
    // with Slack/WhatsApp (1 channel = 1 group, N sessions per group).
    //
    // No token-by-token streaming in v1: ContainerOutput is batch (status +
    // result at end). We emit the full reply as one chunk then `done`. True
    // token streaming requires container-runner to expose intermediate stdout
    // chunks, scheduled for v2.
    if (method === 'POST' && parts[0] === 'chat' && parts.length === 1) {
      const body = await readBody(req).catch(() => null);
      // Accept both shapes:
      //   - Simple: { content: string, sessionId?: string }
      //   - OpenAI-compatible: { messages: [{role,content}], stream, user }
      // The ghosty.studio embed widget posts the OpenAI shape (de-facto
      // standard for chat completion endpoints, so the same widget can talk
      // to any compatible proxy). Extract last user message as the prompt.
      let content = '';
      let sessionId: string | undefined;
      if (typeof body?.content === 'string') {
        content = body.content.trim();
        sessionId =
          typeof body?.sessionId === 'string' ? body.sessionId : undefined;
      } else if (Array.isArray(body?.messages)) {
        const userMsgs = body.messages.filter(
          (m: { role?: string; content?: string }) =>
            m?.role === 'user' && typeof m?.content === 'string',
        );
        content = (userMsgs[userMsgs.length - 1]?.content ?? '').trim();
        sessionId = typeof body?.user === 'string' ? body.user : undefined;
      }
      // Claude Code's --resume requires a UUID-format session ID. The widget
      // sends user="default" (non-UUID) → drop it so runContainerAgent skips
      // --resume and starts a fresh session (it'll generate a real UUID and
      // return it in newSessionId for subsequent turns to use).
      const UUID_RE =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (sessionId && !UUID_RE.test(sessionId)) sessionId = undefined;
      if (!content)
        return send(res, 400, { error: 'content (string) required' });

      const WEB_FOLDER = 'web';
      const WEB_JID = 'web@chat.local';
      let group = getRegisteredGroupByFolder(WEB_FOLDER);
      if (!group) {
        const skeleton: RegisteredGroup = {
          name: 'Web Chat',
          folder: WEB_FOLDER,
          trigger: '',
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        };
        setRegisteredGroup(WEB_JID, skeleton);
        group = getRegisteredGroupByFolder(WEB_FOLDER);
        if (!group)
          return send(res, 500, { error: 'failed to create web group' });
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const writeEvent = (data: unknown) =>
        res.write(`data: ${JSON.stringify(data)}\n\n`);

      // Keep-alive so the proxy doesn't time out while runContainerAgent boots.
      writeEvent({ type: 'ping' });

      // The agent container stays alive between turns for IPC (MCPs + claude
      // CLI hot-cache), so the runContainerAgent promise won't resolve until
      // the container exits. For web chat we want to emit SSE + close as soon
      // as the first result arrives — use the onOutput callback to stream
      // and a manual kill of the container after we've got our result.
      let firstResultEmitted = false;
      let lastResult: ContainerOutput | null = null;
      let containerName = '';
      try {
        await runContainerAgent(
          group,
          {
            prompt: content,
            sessionId,
            groupFolder: group.folder,
            chatJid: WEB_JID,
            isMain: false,
          },
          (_proc, name) => {
            containerName = name;
          },
          async (output: ContainerOutput) => {
            lastResult = output;
            if (!firstResultEmitted) {
              firstResultEmitted = true;
              if (output.status === 'error') {
                writeEvent({
                  type: 'error',
                  message: output.error ?? 'agent error',
                });
              } else if (output.result) {
                writeEvent({ type: 'chunk', value: output.result });
              }
              writeEvent({
                type: 'done',
                sessionId: output.newSessionId ?? sessionId,
              });
              res.end();
              // Don't await container exit — kill it so the promise resolves
              // and we don't pile up zombie containers. The next turn will
              // spawn a fresh one (we lose IPC hot-cache, but for web that's
              // OK — different sessions are typical).
              try {
                if (containerName) {
                  await execFileAsync('docker', ['kill', containerName]);
                }
              } catch {
                // best effort
              }
            }
          },
        );
        // Fallthrough: if onOutput never fired (no streaming output at all),
        // emit a failure event so the widget doesn't hang.
        if (!firstResultEmitted) {
          writeEvent({
            type: 'error',
            message: 'agent produced no output',
          });
          writeEvent({
            type: 'done',
            sessionId:
              (lastResult as ContainerOutput | null)?.newSessionId ?? sessionId,
          });
          res.end();
        }
      } catch (err) {
        if (!firstResultEmitted) {
          writeEvent({
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
          res.end();
        }
      }
      return;
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
