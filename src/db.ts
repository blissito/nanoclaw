import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  ContainerConfig,
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

let db: Database.Database;

export interface Reaction {
  message_id: string;
  message_chat_jid: string;
  reactor_jid: string;
  reactor_name?: string;
  emoji: string;
  timestamp: string;
}

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS image_generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      prompt TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text2img',
      model TEXT NOT NULL DEFAULT 'gpt-image-1',
      cost_usd REAL NOT NULL DEFAULT 0.08,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_image_gen_group ON image_generations(group_folder);
    CREATE INDEX IF NOT EXISTS idx_image_gen_date ON image_generations(created_at);

    CREATE TABLE IF NOT EXISTS usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      num_turns INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_group ON usage_logs(group_folder);
    CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_logs(created_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS formmy_jid_mapping (
      jid TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      integration_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reactions (
      message_id TEXT NOT NULL,
      message_chat_jid TEXT NOT NULL,
      reactor_jid TEXT NOT NULL,
      reactor_name TEXT,
      emoji TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      PRIMARY KEY (message_id, message_chat_jid, reactor_jid)
    );
    CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id, message_chat_jid);
    CREATE INDEX IF NOT EXISTS idx_reactions_reactor ON reactions(reactor_jid);
    CREATE INDEX IF NOT EXISTS idx_reactions_emoji ON reactions(emoji);
    CREATE INDEX IF NOT EXISTS idx_reactions_timestamp ON reactions(timestamp);

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      started_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      closed_at TEXT,
      resolution_status TEXT,
      first_bot_reply_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_conv_agent_activity ON conversations(agent_id, last_activity_at DESC);
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add report_to_jid column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN report_to_jid TEXT DEFAULT NULL`,
    );
  } catch {
    /* column already exists */
  }

  // Add script column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN script TEXT`);
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main' OR folder = 'whatsapp_main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add integration_id to formmy_jid_mapping (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE formmy_jid_mapping ADD COLUMN integration_id TEXT`,
    );
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }

  // Add reply context columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT`);
    database.exec(
      `ALTER TABLE messages ADD COLUMN reply_to_message_content TEXT`,
    );
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_sender_name TEXT`);
  } catch {
    /* columns already exist */
  }

  // WABA coexistence flag (Formmy manual_mode). Must persist + round-trip
  // through SELECT so the message-loop skip in src/index.ts:462 can see it.
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN manual_mode INTEGER DEFAULT 0`,
    );
  } catch {
    /* column already exists */
  }

  // Upstream pause state (Formmy /send returned skipped:true). When set and
  // not yet expired, src/index.ts skips agent spawn entirely — saves the full
  // LLM inference per inbound during operator-only handoff. ISO timestamp;
  // "9999-12-31T..." means manual_permanent (until operator unpauses upstream).
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN paused_until TEXT`);
  } catch {
    /* column already exists */
  }

  // Session age, for the TTL rotation in src/index.ts.
  //
  // The backfill matters more than the column. Leaving existing rows NULL and treating NULL as
  // expired would rotate every pre-existing session on its next message at once — on sofi-0 that
  // was 114 sessions, each firing an archive plus an LLM summarize call. Seeding from the
  // transcript's own birthtime instead gives each session its real age (the sofi-0 session that
  // caused the price incident dates to 2026-05-14) and staggers the rotations naturally.
  try {
    database.exec(`ALTER TABLE sessions ADD COLUMN created_at TEXT`);
    backfillSessionCreatedAt(database);
  } catch {
    /* column already exists — backfill already ran */
  }
}

/** One-shot: date existing sessions from their transcript file. Runs only in the migration that
 *  adds the column, so it can't re-stamp rows later. */
function backfillSessionCreatedAt(database: Database.Database): void {
  const rows = database
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const update = database.prepare(
    'UPDATE sessions SET created_at = ? WHERE group_folder = ?',
  );
  const now = new Date().toISOString();
  for (const row of rows) {
    let stamp = now;
    try {
      const jsonl = path.join(
        DATA_DIR,
        'sessions',
        row.group_folder,
        '.claude',
        'projects',
        '-workspace-group',
        `${row.session_id}.jsonl`,
      );
      const st = fs.statSync(jsonl);
      const birth = st.birthtime?.getTime?.() || 0;
      stamp = new Date(birth > 0 ? birth : st.mtime.getTime()).toISOString();
    } catch {
      /* transcript missing — treat as new rather than instantly expired */
    }
    update.run(stamp, row.group_folder);
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Upstream pause state — set when Formmy /send returns {skipped:true} or when
 * the inbound webhook signals an active pause. Used by src/index.ts to skip
 * agent spawn entirely (no LLM inference) while the operator owns the chat.
 *
 * Returns the ISO timestamp the pause expires at, or null if not paused.
 * Callers should treat past timestamps as "not paused" — the cleanup happens
 * on the next successful send (clearChatPauseUntil) or on schema reads.
 */
export function getChatPauseUntil(chatJid: string): string | null {
  const row = db
    .prepare(`SELECT paused_until FROM chats WHERE jid = ?`)
    .get(chatJid) as { paused_until: string | null } | undefined;
  return row?.paused_until || null;
}

export function setChatPauseUntil(chatJid: string, until: string): void {
  // Upsert: row may not exist yet if pause learned before first message stored.
  db.prepare(
    `INSERT INTO chats (jid, paused_until) VALUES (?, ?)
     ON CONFLICT(jid) DO UPDATE SET paused_until = excluded.paused_until`,
  ).run(chatJid, until);
}

export function clearChatPauseUntil(chatJid: string): void {
  db.prepare(`UPDATE chats SET paused_until = NULL WHERE jid = ?`).run(chatJid);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, reply_to_message_id, reply_to_message_content, reply_to_sender_name, manual_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.reply_to_message_id ?? null,
    msg.reply_to_message_content ?? null,
    msg.reply_to_sender_name ?? null,
    msg.manual_mode ? 1 : 0,
  );
}

/**
 * Store a message directly (for non-WhatsApp channels that don't use Baileys proto).
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, 1000) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit = 1000,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name,
             manual_mode
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

/**
 * True if any message in this chat has manual_mode=1 with timestamp > since.
 * Used as an OUTPUT-TIME pause check in src/index.ts: when the agent finishes
 * a turn that started before a coexistence pause was applied, suppress its
 * outputs instead of dumping them on the customer after the operator took
 * over. The spawn-time check in processGroupMessages catches new turns; this
 * one catches in-flight turns whose outputs would arrive late.
 */
export function hasManualModeSince(chatJid: string, since: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM messages
       WHERE chat_jid = ? AND manual_mode = 1 AND timestamp > ?
       LIMIT 1`,
    )
    .get(chatJid, since) as { 1: number } | undefined;
  return row !== undefined;
}

export function getMessageFromMe(messageId: string, chatJid: string): boolean {
  const row = db
    .prepare(
      `SELECT is_from_me FROM messages WHERE id = ? AND chat_jid = ? LIMIT 1`,
    )
    .get(messageId, chatJid) as { is_from_me: number | null } | undefined;
  return row?.is_from_me === 1;
}

export function getLatestMessage(
  chatJid: string,
): { id: string; fromMe: boolean } | undefined {
  const row = db
    .prepare(
      `SELECT id, is_from_me FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT 1`,
    )
    .get(chatJid) as { id: string; is_from_me: number | null } | undefined;
  if (!row) return undefined;
  return { id: row.id, fromMe: row.is_from_me === 1 };
}

export function storeReaction(reaction: Reaction): void {
  if (!reaction.emoji) {
    db.prepare(
      `DELETE FROM reactions WHERE message_id = ? AND message_chat_jid = ? AND reactor_jid = ?`,
    ).run(reaction.message_id, reaction.message_chat_jid, reaction.reactor_jid);
    return;
  }
  db.prepare(
    `INSERT OR REPLACE INTO reactions (message_id, message_chat_jid, reactor_jid, reactor_name, emoji, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    reaction.message_id,
    reaction.message_chat_jid,
    reaction.reactor_jid,
    reaction.reactor_name || null,
    reaction.emoji,
    reaction.timestamp,
  );
}

export function getReactionsForMessage(
  messageId: string,
  chatJid: string,
): Reaction[] {
  return db
    .prepare(
      `SELECT * FROM reactions WHERE message_id = ? AND message_chat_jid = ? ORDER BY timestamp`,
    )
    .all(messageId, chatJid) as Reaction[];
}

export function getMessagesByReaction(
  reactorJid: string,
  emoji: string,
  chatJid?: string,
): Array<
  Reaction & { content: string; sender_name: string; message_timestamp: string }
> {
  const sql = chatJid
    ? `
      SELECT r.*, m.content, m.sender_name, m.timestamp as message_timestamp
      FROM reactions r
      JOIN messages m ON r.message_id = m.id AND r.message_chat_jid = m.chat_jid
      WHERE r.reactor_jid = ? AND r.emoji = ? AND r.message_chat_jid = ?
      ORDER BY r.timestamp DESC
    `
    : `
      SELECT r.*, m.content, m.sender_name, m.timestamp as message_timestamp
      FROM reactions r
      JOIN messages m ON r.message_id = m.id AND r.message_chat_jid = m.chat_jid
      WHERE r.reactor_jid = ? AND r.emoji = ?
      ORDER BY r.timestamp DESC
    `;

  type Result = Reaction & {
    content: string;
    sender_name: string;
    message_timestamp: string;
  };
  return chatJid
    ? (db.prepare(sql).all(reactorJid, emoji, chatJid) as Result[])
    : (db.prepare(sql).all(reactorJid, emoji) as Result[]);
}

export function getReactionsByUser(
  reactorJid: string,
  limit: number = 50,
): Reaction[] {
  return db
    .prepare(
      `SELECT * FROM reactions WHERE reactor_jid = ? ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(reactorJid, limit) as Reaction[];
}

export function getReactionStats(chatJid?: string): Array<{
  emoji: string;
  count: number;
}> {
  const sql = chatJid
    ? `
      SELECT emoji, COUNT(*) as count
      FROM reactions
      WHERE message_chat_jid = ?
      GROUP BY emoji
      ORDER BY count DESC
    `
    : `
      SELECT emoji, COUNT(*) as count
      FROM reactions
      GROUP BY emoji
      ORDER BY count DESC
    `;

  type Result = { emoji: string; count: number };
  return chatJid
    ? (db.prepare(sql).all(chatJid) as Result[])
    : (db.prepare(sql).all() as Result[]);
}

export function getLastBotMessageTimestamp(
  chatJid: string,
  botPrefix: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT MAX(timestamp) as ts FROM messages
       WHERE chat_jid = ? AND (is_bot_message = 1 OR content LIKE ?)`,
    )
    .get(chatJid, `${botPrefix}:%`) as { ts: string | null } | undefined;
  return row?.ts ?? undefined;
}

export function findMembersByName(
  chatJid: string,
  names: string[],
): { name: string; jid: string }[] {
  if (names.length === 0) return [];
  const conditions = names.map(() => 'LOWER(sender_name) LIKE ?').join(' OR ');
  const sql = `
    SELECT DISTINCT sender AS jid, sender_name AS name
    FROM messages
    WHERE chat_jid = ? AND is_bot_message = 0 AND sender_name != '' AND (${conditions})
  `;
  const params = names.map((n) => `%${n.toLowerCase()}%`);
  return db.prepare(sql).all(chatJid, ...params) as {
    name: string;
    jid: string;
  }[];
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, report_to_jid, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.script || null,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.report_to_jid || null,
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'script'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.script !== undefined) {
    fields.push('script = ?');
    values.push(updates.script || null);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

/**
 * Persist the group's current session id.
 *
 * NOT `INSERT OR REPLACE`: that deletes and reinserts, which would reset `created_at` on every
 * single turn — the host writes this row each time the container reports a session id. The TTL
 * rotation would then never fire, silently, because no session would ever look older than one
 * message. Age is only reset when the session id actually changes.
 */
export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    `INSERT INTO sessions (group_folder, session_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT(group_folder) DO UPDATE SET
       session_id = excluded.session_id,
       created_at = CASE WHEN sessions.session_id = excluded.session_id
                    THEN sessions.created_at ELSE excluded.created_at END`,
  ).run(groupFolder, sessionId, new Date().toISOString());
}

/** Session id plus its age, for the TTL check at spawn. `created_at` is null only for rows that
 *  predate the migration and had no readable transcript. */
export function getSessionRow(
  groupFolder: string,
): { sessionId: string; createdAt: string | null } | undefined {
  const row = db
    .prepare(
      'SELECT session_id, created_at FROM sessions WHERE group_folder = ?',
    )
    .get(groupFolder) as
    | { session_id: string; created_at: string | null }
    | undefined;
  return row
    ? { sessionId: row.session_id, createdAt: row.created_at }
    : undefined;
}

export function deleteSession(groupFolder: string): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
  );
}

export function deleteRegisteredGroup(jid: string): void {
  db.prepare('DELETE FROM registered_groups WHERE jid = ?').run(jid);
}

// Auto-register a per-user Formmy WABA group with the public template.
// Idempotent: existing rows are not overwritten (admin may have customized them).
// Returns true when a new row was inserted.
export function registerFormmyUserGroup(
  jid: string,
  folder: string,
  name: string,
  template: ContainerConfig,
): boolean {
  if (!isValidGroupFolder(folder)) {
    throw new Error(`Invalid group folder "${folder}" for JID ${jid}`);
  }
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      jid,
      name,
      folder,
      '.*', // 1-to-1 chat: respond to every message
      new Date().toISOString(),
      JSON.stringify(template),
      0, // requires_trigger=false for solo chats
      0, // is_main=false
    );
  return result.changes > 0;
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1,
    };
  }
  return result;
}

export function getRegisteredGroupByFolder(
  folder: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE folder = ?')
    .get(folder) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) return undefined;
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

// --- Image generation tracking ---

export function trackImageGeneration(params: {
  group_folder: string;
  prompt: string;
  type: string;
  model?: string;
  cost_usd?: number;
}): void {
  db.prepare(
    `INSERT INTO image_generations (group_folder, prompt, type, model, cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    params.group_folder,
    params.prompt,
    params.type,
    params.model || 'gpt-image-1',
    params.cost_usd ?? 0.08,
    new Date().toISOString(),
  );
}

export interface ImageGenStats {
  total_images: number;
  total_cost_usd: number;
  by_type: { type: string; count: number; cost: number }[];
  by_group: { group_folder: string; count: number; cost: number }[];
}

export function getImageGenStats(sinceDate?: string): ImageGenStats {
  const whereClause = sinceDate ? 'WHERE created_at >= ?' : '';
  const params = sinceDate ? [sinceDate] : [];

  const totals = db
    .prepare(
      `SELECT COUNT(*) as total_images, COALESCE(SUM(cost_usd), 0) as total_cost_usd
       FROM image_generations ${whereClause}`,
    )
    .get(...params) as { total_images: number; total_cost_usd: number };

  const byType = db
    .prepare(
      `SELECT type, COUNT(*) as count, COALESCE(SUM(cost_usd), 0) as cost
       FROM image_generations ${whereClause}
       GROUP BY type`,
    )
    .all(...params) as { type: string; count: number; cost: number }[];

  const byGroup = db
    .prepare(
      `SELECT group_folder, COUNT(*) as count, COALESCE(SUM(cost_usd), 0) as cost
       FROM image_generations ${whereClause}
       GROUP BY group_folder`,
    )
    .all(...params) as {
    group_folder: string;
    count: number;
    cost: number;
  }[];

  return {
    total_images: totals.total_images,
    total_cost_usd: totals.total_cost_usd,
    by_type: byType,
    by_group: byGroup,
  };
}

// --- Usage tracking ---

export interface UsageLog {
  group_folder: string;
  chat_jid: string;
  total_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  num_turns: number;
  duration_ms: number;
}

export function logUsage(log: UsageLog): number {
  const result = db
    .prepare(
      `INSERT INTO usage_logs (group_folder, chat_jid, total_cost_usd, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, num_turns, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      log.group_folder,
      log.chat_jid,
      log.total_cost_usd,
      log.input_tokens,
      log.output_tokens,
      log.cache_read_input_tokens,
      log.cache_creation_input_tokens,
      log.num_turns,
      log.duration_ms,
      new Date().toISOString(),
    );
  return Number(result.lastInsertRowid);
}

export interface UsageStats {
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_queries: number;
  by_group: {
    group_folder: string;
    cost: number;
    queries: number;
    tokens: number;
  }[];
}

export function getUsageStats(sinceDate?: string): UsageStats {
  const where = sinceDate ? 'WHERE created_at >= ?' : '';
  const params = sinceDate ? [sinceDate] : [];

  const totals = db
    .prepare(
      `SELECT COUNT(*) as total_queries, COALESCE(SUM(total_cost_usd), 0) as total_cost,
              COALESCE(SUM(input_tokens), 0) as total_input, COALESCE(SUM(output_tokens), 0) as total_output
       FROM usage_logs ${where}`,
    )
    .get(...(params as string[])) as {
    total_queries: number;
    total_cost: number;
    total_input: number;
    total_output: number;
  };

  const byGroup = db
    .prepare(
      `SELECT group_folder, COALESCE(SUM(total_cost_usd), 0) as cost, COUNT(*) as queries,
              COALESCE(SUM(input_tokens + output_tokens), 0) as tokens
       FROM usage_logs ${where}
       GROUP BY group_folder ORDER BY cost DESC`,
    )
    .all(...(params as string[])) as {
    group_folder: string;
    cost: number;
    queries: number;
    tokens: number;
  }[];

  return {
    total_cost_usd: totals.total_cost,
    total_input_tokens: totals.total_input,
    total_output_tokens: totals.total_output,
    total_queries: totals.total_queries,
    by_group: byGroup,
  };
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}

// --- Formmy JID mapping (Business API JIDs → group folders) ---

export function getFormmyJidMapping(
  jid: string,
): { group_folder: string; integration_id: string | null } | null {
  const row = db
    .prepare(
      'SELECT group_folder, integration_id FROM formmy_jid_mapping WHERE jid = ?',
    )
    .get(jid) as
    | { group_folder: string; integration_id: string | null }
    | undefined;
  return row ?? null;
}

export function getFormmyGroupFolder(jid: string): string | null {
  return getFormmyJidMapping(jid)?.group_folder ?? null;
}

export function getFormmyIntegrationId(jid: string): string | null {
  return getFormmyJidMapping(jid)?.integration_id ?? null;
}

/**
 * True if the integration_id is already known on this droplet (i.e. at least
 * one JID has been mapped to it). Used by the channel to decide whether a JID
 * of the form formmy_<int_id>_<phone> can be safely canonicalized to the
 * legacy formmy_<phone>@s.whatsapp.net form — we only collapse when we're
 * confident the integration belongs to us, never blindly.
 */
export function isKnownIntegrationId(integrationId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM formmy_jid_mapping WHERE integration_id = ? LIMIT 1`,
    )
    .get(integrationId) as { 1: number } | undefined;
  return row !== undefined;
}

export function setFormmyJidMapping(
  jid: string,
  folder: string,
  integrationId?: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO formmy_jid_mapping (jid, group_folder, integration_id, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(jid, folder, integrationId ?? null, new Date().toISOString());
}

export function getAllFormmyJids(): string[] {
  const rows = db.prepare('SELECT jid FROM formmy_jid_mapping').all() as {
    jid: string;
  }[];
  return rows.map((r) => r.jid);
}

export function getFormmyJidsByIntegrationId(
  integrationId: string,
): Array<{ jid: string; group_folder: string }> {
  return db
    .prepare(
      'SELECT jid, group_folder FROM formmy_jid_mapping WHERE integration_id = ?',
    )
    .all(integrationId) as Array<{ jid: string; group_folder: string }>;
}

export function deleteFormmyJidMapping(jid: string): void {
  db.prepare('DELETE FROM formmy_jid_mapping WHERE jid = ?').run(jid);
}

export function deleteMessagesByChatJid(chatJid: string): number {
  const r = db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(chatJid);
  return r.changes;
}

/* -------------------------------------------------------------------------- */
/* Conversations — lightweight conversation lifecycle for dashboard telemetry.*/
/* See docs/PUBLIC_AGENT_SURFACE.md if it exists, or plan in                   */
/* ~/.claude/plans/distributed-napping-neumann.md.                            */
/* -------------------------------------------------------------------------- */

export type ResolutionStatus =
  | 'resolved_by_bot'
  | 'resolved_manual'
  | 'handed_off'
  | 'abandoned';

export interface ConversationRow {
  id: string;
  agent_id: string;
  chat_jid: string;
  started_at: string;
  last_activity_at: string;
  closed_at: string | null;
  resolution_status: ResolutionStatus | null;
  first_bot_reply_at: string | null;
}

const CONV_REOPEN_WINDOW_MS = 30 * 60 * 1000; // 30 min

function generateConversationId(): string {
  // ulid-ish: timestamp (base36) + random. Good enough for our scale.
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Return id of an open conversation for (agentId, chatJid). Reuses the most
 * recent open row if last_activity_at < 30 min ago; otherwise opens a new one.
 * Also bumps last_activity_at to now.
 */
export function getOrOpenConversation(
  agentId: string,
  chatJid: string,
): string {
  const now = new Date().toISOString();
  const existing = db
    .prepare(
      `SELECT id, last_activity_at FROM conversations
       WHERE agent_id = ? AND chat_jid = ? AND closed_at IS NULL
       ORDER BY last_activity_at DESC LIMIT 1`,
    )
    .get(agentId, chatJid) as
    | { id: string; last_activity_at: string }
    | undefined;

  if (existing) {
    const ageMs = Date.now() - Date.parse(existing.last_activity_at);
    if (ageMs < CONV_REOPEN_WINDOW_MS) {
      db.prepare(
        `UPDATE conversations SET last_activity_at = ? WHERE id = ?`,
      ).run(now, existing.id);
      return existing.id;
    }
    // Idle too long — auto-close as abandoned and open a fresh one.
    db.prepare(
      `UPDATE conversations SET closed_at = ?, resolution_status = 'abandoned' WHERE id = ?`,
    ).run(now, existing.id);
  }

  const id = generateConversationId();
  db.prepare(
    `INSERT INTO conversations (id, agent_id, chat_jid, started_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, agentId, chatJid, now, now);
  return id;
}

/** Bump last_activity_at without conditional logic. Used when we already have an id. */
export function touchConversation(id: string): void {
  db.prepare(`UPDATE conversations SET last_activity_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    id,
  );
}

/** Set first_bot_reply_at only if it's still NULL. Idempotent. */
export function markFirstBotReply(id: string, ts?: string): void {
  db.prepare(
    `UPDATE conversations SET first_bot_reply_at = ?
     WHERE id = ? AND first_bot_reply_at IS NULL`,
  ).run(ts || new Date().toISOString(), id);
}

/** Close a conversation. No-op if already closed. */
export function closeConversation(id: string, status: ResolutionStatus): void {
  db.prepare(
    `UPDATE conversations SET closed_at = ?, resolution_status = ?
     WHERE id = ? AND closed_at IS NULL`,
  ).run(new Date().toISOString(), status, id);
}

/**
 * Find the most recent open conversation for a chat across all agents. Used by
 * outbound hooks where we don't know the agent_id directly (the channel knows
 * the jid; the conversation row knows the agent).
 */
export function findOpenConversationByChatJid(
  chatJid: string,
): { id: string; agent_id: string } | null {
  const row = db
    .prepare(
      `SELECT id, agent_id FROM conversations
       WHERE chat_jid = ? AND closed_at IS NULL
       ORDER BY last_activity_at DESC LIMIT 1`,
    )
    .get(chatJid) as { id: string; agent_id: string } | undefined;
  return row || null;
}

export interface ConversationListItem extends ConversationRow {
  turn_count: number;
  total_cost_usd: number;
}

/**
 * List conversations for an agent. Joins usage_logs for turn count + cost.
 * `status` filter: 'open' = closed_at IS NULL, 'closed' = NOT NULL, 'all' = no filter.
 * Cursor pagination via `before` (= last row's id) is intentionally omitted in v1;
 * `limit` caps the response and consumers can re-poll.
 */
export function listConversations(
  agentId: string,
  opts: { status?: 'open' | 'closed' | 'all'; limit?: number } = {},
): ConversationListItem[] {
  const status = opts.status || 'all';
  const limit = Math.min(opts.limit || 50, 500);
  const where =
    status === 'open'
      ? 'AND c.closed_at IS NULL'
      : status === 'closed'
        ? 'AND c.closed_at IS NOT NULL'
        : '';
  return db
    .prepare(
      `SELECT c.*,
              COALESCE((SELECT SUM(num_turns) FROM usage_logs u
                        WHERE u.group_folder = c.agent_id
                          AND u.chat_jid = c.chat_jid
                          AND u.created_at >= c.started_at
                          AND (c.closed_at IS NULL OR u.created_at <= c.closed_at)
                       ), 0) AS turn_count,
              COALESCE((SELECT SUM(total_cost_usd) FROM usage_logs u
                        WHERE u.group_folder = c.agent_id
                          AND u.chat_jid = c.chat_jid
                          AND u.created_at >= c.started_at
                          AND (c.closed_at IS NULL OR u.created_at <= c.closed_at)
                       ), 0) AS total_cost_usd
       FROM conversations c
       WHERE c.agent_id = ? ${where}
       ORDER BY c.last_activity_at DESC
       LIMIT ?`,
    )
    .all(agentId, limit) as ConversationListItem[];
}

export function getConversation(id: string): ConversationListItem | null {
  const row = db
    .prepare(
      `SELECT c.*,
              COALESCE((SELECT SUM(num_turns) FROM usage_logs u
                        WHERE u.group_folder = c.agent_id
                          AND u.chat_jid = c.chat_jid
                          AND u.created_at >= c.started_at
                          AND (c.closed_at IS NULL OR u.created_at <= c.closed_at)
                       ), 0) AS turn_count,
              COALESCE((SELECT SUM(total_cost_usd) FROM usage_logs u
                        WHERE u.group_folder = c.agent_id
                          AND u.chat_jid = c.chat_jid
                          AND u.created_at >= c.started_at
                          AND (c.closed_at IS NULL OR u.created_at <= c.closed_at)
                       ), 0) AS total_cost_usd
       FROM conversations c WHERE c.id = ?`,
    )
    .get(id) as ConversationListItem | undefined;
  return row || null;
}

export function setConversationResolution(
  id: string,
  status: ResolutionStatus,
): ConversationListItem | null {
  const existing = db
    .prepare(`SELECT closed_at FROM conversations WHERE id = ?`)
    .get(id) as { closed_at: string | null } | undefined;
  if (!existing) return null;
  const now = new Date().toISOString();
  // If already closed, only update the status label; don't shift closed_at.
  if (existing.closed_at) {
    db.prepare(
      `UPDATE conversations SET resolution_status = ? WHERE id = ?`,
    ).run(status, id);
  } else {
    db.prepare(
      `UPDATE conversations SET closed_at = ?, resolution_status = ? WHERE id = ?`,
    ).run(now, status, id);
  }
  return getConversation(id);
}

export interface AgentMetrics {
  window: { start: string; end: string };
  totals: {
    conversations: number;
    conversationsClosed: number;
    turns: number;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
  };
  rates: {
    containmentRate: number;
    escalationRate: number;
    errorRate: number;
  };
  latency: {
    firstResponseP50Ms: number | null;
    firstResponseP95Ms: number | null;
    resolutionP50Ms: number | null;
    resolutionP95Ms: number | null;
  };
  cost: {
    costPerTurn: number | null;
    costPerResolved: number | null;
  };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[idx];
}

export function computeAgentMetrics(
  agentId: string,
  windowHours: number,
): AgentMetrics {
  const end = new Date();
  const start = new Date(end.getTime() - windowHours * 3600 * 1000);
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const convs = db
    .prepare(
      `SELECT started_at, closed_at, resolution_status, first_bot_reply_at
       FROM conversations
       WHERE agent_id = ? AND last_activity_at >= ?`,
    )
    .all(agentId, startIso) as Array<{
    started_at: string;
    closed_at: string | null;
    resolution_status: ResolutionStatus | null;
    first_bot_reply_at: string | null;
  }>;

  const usage = db
    .prepare(
      `SELECT COALESCE(SUM(num_turns),0) AS turns,
              COALESCE(SUM(total_cost_usd),0) AS cost,
              COALESCE(SUM(input_tokens),0) AS in_tok,
              COALESCE(SUM(output_tokens),0) AS out_tok
       FROM usage_logs
       WHERE group_folder = ? AND created_at >= ?`,
    )
    .get(agentId, startIso) as {
    turns: number;
    cost: number;
    in_tok: number;
    out_tok: number;
  };

  const closed = convs.filter((c) => c.closed_at);
  const resolvedByBot = convs.filter(
    (c) => c.resolution_status === 'resolved_by_bot',
  );
  const handedOff = convs.filter((c) => c.resolution_status === 'handed_off');
  const closedNoReply = closed.filter((c) => !c.first_bot_reply_at);

  const frtSamples = convs
    .filter((c) => c.first_bot_reply_at)
    .map((c) => Date.parse(c.first_bot_reply_at!) - Date.parse(c.started_at))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);

  const resolutionSamples = closed
    .map((c) => Date.parse(c.closed_at!) - Date.parse(c.started_at))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);

  return {
    window: { start: startIso, end: endIso },
    totals: {
      conversations: convs.length,
      conversationsClosed: closed.length,
      turns: usage.turns,
      costUsd: usage.cost,
      inputTokens: usage.in_tok,
      outputTokens: usage.out_tok,
    },
    rates: {
      containmentRate: closed.length ? resolvedByBot.length / closed.length : 0,
      escalationRate: convs.length ? handedOff.length / convs.length : 0,
      errorRate: closed.length ? closedNoReply.length / closed.length : 0,
    },
    latency: {
      firstResponseP50Ms: percentile(frtSamples, 50),
      firstResponseP95Ms: percentile(frtSamples, 95),
      resolutionP50Ms: percentile(resolutionSamples, 50),
      resolutionP95Ms: percentile(resolutionSamples, 95),
    },
    cost: {
      costPerTurn: usage.turns ? usage.cost / usage.turns : null,
      costPerResolved: resolvedByBot.length
        ? usage.cost / resolvedByBot.length
        : null,
    },
  };
}
