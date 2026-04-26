/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { query, HookCallback, PreCompactHookInput, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  mcpServers?: string[];
  allowedTools?: string[];
  reportToJid?: string;
  script?: string;
  imageAttachments?: Array<{ relativePath: string; mediaType: string; publicUrl?: string }>;
}

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
type ContentBlock = ContentBlockParam;

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}


const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_MESSAGES_DIR = '/workspace/ipc/messages';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  pushMultimodal(content: ContentBlock[]): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

type McpServerConfig = Record<string, { command: string; args: string[]; env: Record<string, string> }>;

function getAllMcpServers(containerInput: ContainerInput, mcpServerPath: string): McpServerConfig {
  return {
    nanoclaw: {
      command: 'node',
      args: [mcpServerPath],
      env: {
        NANOCLAW_CHAT_JID: containerInput.chatJid,
        NANOCLAW_REPORT_TO_JID: containerInput.reportToJid || '',
        NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
        NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
        SES_REGION: process.env.SES_REGION || '',
        SES_KEY: process.env.SES_KEY || '',
        SES_SECRET: process.env.SES_SECRET || '',
        SES_FROM_EMAIL: process.env.SES_FROM_EMAIL || '',
        SES_FROM_NAME: process.env.SES_FROM_NAME || '',
        SES_CONFIGURATION_SET: process.env.SES_CONFIGURATION_SET || '',
      },
    },
    easybits: {
      command: 'npx',
      args: ['-y', '@easybits.cloud/mcp'],
      env: {
        EASYBITS_API_KEY: process.env.EASYBITS_API_KEY || '',
      },
    },
    'easybits-magnet': {
      command: 'npx',
      args: ['-y', '@easybits.cloud/mcp', '--tools', 'core,magnet'],
      env: {
        EASYBITS_API_KEY: process.env.EASYBITS_API_KEY || '',
      },
    },
    smatch: {
      command: 'npx',
      args: ['-y', 'smatch-mcp'],
      env: {
        SMATCH_MONGODB_URI: process.env.SMATCH_MONGODB_URI || '',
        SMATCH_CLUB_ID: process.env.SMATCH_CLUB_ID || '',
      },
    },
    'smatch-public': {
      command: 'npx',
      args: ['-y', 'smatch-mcp-public'],
      env: {
        SMATCH_MONGODB_URI: process.env.SMATCH_MONGODB_URI || '',
        SMATCH_CLUB_ID: process.env.SMATCH_CLUB_ID || '',
      },
    },
    brightdata: {
      command: 'npx',
      args: ['-y', '@brightdata/mcp'],
      env: {
        API_TOKEN: process.env.BRIGHTDATA_API_TOKEN || '',
        GROUPS: 'geo,social,business,ecommerce,finance',
      },
    },
    kommo: {
      command: 'node',
      args: ['/app/mcp-servers/kommo/dist/index.js'],
      env: {
        KOMMO_BASE_URL: process.env.KOMMO_BASE_URL || '',
        KOMMO_ACCESS_TOKEN: process.env.KOMMO_ACCESS_TOKEN || '',
      },
    },
  };
}

function buildMcpServers(containerInput: ContainerInput, mcpServerPath: string): McpServerConfig {
  const all = getAllMcpServers(containerInput, mcpServerPath);
  if (!containerInput.mcpServers) return all;

  const enabled = new Set(['nanoclaw', ...containerInput.mcpServers]);
  const result: McpServerConfig = {};
  for (const name of enabled) {
    if (all[name]) result[name] = all[name];
  }
  return result;
}

function buildAllowedTools(containerInput: ContainerInput, mcpServerPath: string): string[] {
  const mcpServers = buildMcpServers(containerInput, mcpServerPath);
  const mcpTools = Object.keys(mcpServers).map(n => `mcp__${n}__*`);

  // Per-group override: only allow specified tools + MCP tools for enabled servers
  if (containerInput.allowedTools?.length) {
    return [...containerInput.allowedTools, ...mcpTools];
  }

  return [
    'Bash',
    'Read', 'Write', 'Edit', 'Glob', 'Grep',
    'WebSearch', 'WebFetch',
    'Task', 'TaskOutput', 'TaskStop',
    'TeamCreate', 'TeamDelete', 'SendMessage',
    'TodoWrite', 'ToolSearch', 'Skill',
    'NotebookEdit',
    ...mcpTools,
  ];
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean; numTurns: number }> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Load image attachments and send as multimodal content blocks
  if (containerInput.imageAttachments?.length) {
    const blocks: ContentBlock[] = [];
    for (const img of containerInput.imageAttachments) {
      // Prefer URL (lightweight) over base64 (heavy)
      if (img.publicUrl) {
        log(`Using URL for image: ${img.publicUrl}`);
        blocks.push({ type: 'image', source: { type: 'url', url: img.publicUrl } });
        continue;
      }
      // Fallback to base64 if no URL available
      const imgPath = path.join('/workspace/group', img.relativePath);
      try {
        const raw = fs.readFileSync(imgPath);
        const isValidJpeg = raw.length >= 3 && raw[0] === 0xFF && raw[1] === 0xD8 && raw[2] === 0xFF;
        const isValidPng = raw.length >= 4 && raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4E && raw[3] === 0x47;
        if (!isValidJpeg && !isValidPng) {
          log(`Skipping image with invalid header: ${imgPath} (${raw.length} bytes)`);
          continue;
        }
        if (raw.length < 1024) {
          log(`Skipping tiny image: ${imgPath} (${raw.length} bytes)`);
          continue;
        }
        const data = raw.toString('base64');
        log(`Fallback to base64 for image: ${imgPath} (${raw.length} bytes)`);
        blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data } });
      } catch (err) {
        log(`Failed to load image: ${imgPath}`);
      }
    }
    if (blocks.length > 0) {
      stream.pushMultimodal(blocks);
    }
  }

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let lastModel: string | undefined;
  let lastServiceTier: string | undefined;
  let messageCount = 0;
  let resultCount = 0;
  let numTurns = 0;

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: globalClaudeMd || undefined,
      allowedTools: buildAllowedTools(containerInput, mcpServerPath),
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: buildMcpServers(containerInput, mcpServerPath),
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
      },
    }
  })) {
    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
      const am = message as { message?: { model?: string } };
      if (am.message?.model) lastModel = am.message.model;
      const tier = (message as { message?: { usage?: { service_tier?: string } } })
        .message?.usage?.service_tier;
      if (tier) lastServiceTier = tier;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
    }

    if (message.type === 'result') {
      resultCount++;
      const r = message as {
        result?: string;
        subtype?: string;
        total_cost_usd?: number;
        usage?: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number };
        num_turns?: number;
        duration_ms?: number;
      };
      const textResult = r.result || null;
      if (r.num_turns) numTurns = r.num_turns;
      log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
      if (r.total_cost_usd != null) {
        log(`Usage: cost=$${r.total_cost_usd.toFixed(4)} input=${r.usage?.inputTokens || 0} output=${r.usage?.outputTokens || 0} cache_read=${r.usage?.cacheReadInputTokens || 0} turns=${r.num_turns || 0} duration=${r.duration_ms || 0}ms`);
      }
      writeOutput({
        status: 'success',
        result: textResult,
        newSessionId,
        ...(r.total_cost_usd != null && {
          usage: {
            total_cost_usd: r.total_cost_usd,
            input_tokens: r.usage?.inputTokens || 0,
            output_tokens: r.usage?.outputTokens || 0,
            cache_read_input_tokens: r.usage?.cacheReadInputTokens || 0,
            cache_creation_input_tokens: r.usage?.cacheCreationInputTokens || 0,
            num_turns: r.num_turns || 0,
            duration_ms: r.duration_ms || 0,
            model: lastModel,
            service_tier: lastServiceTier,
          },
        }),
      });
    }
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}, numTurns: ${numTurns}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery, numTurns };
}

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

const SCRIPT_TIMEOUT_MS = 30_000;

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile('bash', [scriptPath], {
      timeout: SCRIPT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: process.env,
    }, (error, stdout, stderr) => {
      if (stderr) {
        log(`Script stderr: ${stderr.slice(0, 500)}`);
      }

      if (error) {
        log(`Script error: ${error.message}`);
        return resolve(null);
      }

      // Parse last non-empty line of stdout as JSON
      const lines = stdout.trim().split('\n');
      const lastLine = lines[lines.length - 1];
      if (!lastLine) {
        log('Script produced no output');
        return resolve(null);
      }

      try {
        const result = JSON.parse(lastLine);
        if (typeof result.wakeAgent !== 'boolean') {
          log(`Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`);
          return resolve(null);
        }
        resolve(result as ScriptResult);
      } catch {
        log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
        resolve(null);
      }
    });
  });
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  const sdkEnv: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '165000',
  };

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Script phase: run script before waking agent
  if (containerInput.script && containerInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInput.script);

    if (!scriptResult || !scriptResult.wakeAgent) {
      const reason = scriptResult ? 'wakeAgent=false' : 'script error/no output';
      log(`Script decided not to wake agent: ${reason}`);
      writeOutput({
        status: 'success',
        result: `Script: ${reason}`,
      });
      return;
    }

    // Script says wake agent — enrich prompt with script data
    log(`Script wakeAgent=true, enriching prompt with data`);
    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${containerInput.prompt}`;
  }

  // --- Slash command handling ---
  // Only known session slash commands are handled here. This prevents
  // accidental interception of user prompts that happen to start with '/'.
  const KNOWN_SESSION_COMMANDS = new Set(['/compact']);
  const trimmedPrompt = prompt.trim();
  const isSessionSlashCommand = KNOWN_SESSION_COMMANDS.has(trimmedPrompt);

  if (isSessionSlashCommand) {
    log(`Handling session command: ${trimmedPrompt}`);
    let slashSessionId: string | undefined;
    let compactBoundarySeen = false;
    let hadError = false;
    let resultEmitted = false;

    try {
      for await (const message of query({
        prompt: trimmedPrompt,
        options: {
          cwd: '/workspace/group',
          resume: sessionId,
          systemPrompt: undefined,
          allowedTools: [],
          env: sdkEnv,
          permissionMode: 'bypassPermissions' as const,
          allowDangerouslySkipPermissions: true,
          settingSources: ['project', 'user'] as const,
          hooks: {
            PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
          },
        },
      })) {
        const msgType = message.type === 'system'
          ? `system/${(message as { subtype?: string }).subtype}`
          : message.type;
        log(`[slash-cmd] type=${msgType}`);

        if (message.type === 'system' && message.subtype === 'init') {
          slashSessionId = message.session_id;
          log(`Session after slash command: ${slashSessionId}`);
        }

        // Observe compact_boundary to confirm compaction completed
        if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
          compactBoundarySeen = true;
          log('Compact boundary observed — compaction completed');
        }

        if (message.type === 'result') {
          const resultSubtype = (message as { subtype?: string }).subtype;
          const textResult = 'result' in message ? (message as { result?: string }).result : null;

          if (resultSubtype?.startsWith('error')) {
            hadError = true;
            writeOutput({
              status: 'error',
              result: null,
              error: textResult || 'Session command failed.',
              newSessionId: slashSessionId,
            });
          } else {
            writeOutput({
              status: 'success',
              result: 'Conversation compacted.',
              newSessionId: slashSessionId,
            });
          }
          resultEmitted = true;
        }
      }
    } catch (err) {
      hadError = true;
      const errorMsg = err instanceof Error ? err.message : String(err);
      log(`Slash command error: ${errorMsg}`);
      writeOutput({ status: 'error', result: null, error: errorMsg });
    }

    log(`Slash command done. compactBoundarySeen=${compactBoundarySeen}, hadError=${hadError}`);

    // Warn if compact_boundary was never observed — compaction may not have occurred
    if (!hadError && !compactBoundarySeen) {
      log('WARNING: compact_boundary was not observed. Compaction may not have completed.');
    }

    // After successful compaction, ask for a brief session summary
    if (!hadError && compactBoundarySeen && slashSessionId) {
      log('Requesting post-compact session summary...');
      let summary = '';
      try {
        for await (const message of query({
          prompt: 'Responde en 2-3 líneas máximo: ¿Qué se discutió en esta conversación y cuál es el estado actual? No digas que compactaste, solo el resumen del contenido. Si hay tareas pendientes o trabajo incompleto, al final lista cada una como un comando que el usuario podría mandar al chat para retomarla. Formato:\n\nPendientes:\n- "comando para retomar tarea 1"\n- "comando para retomar tarea 2"\n\nSi no hay pendientes, no pongas la sección.',
          options: {
            cwd: '/workspace/group',
            resume: slashSessionId,
            systemPrompt: undefined,
            allowedTools: [],
            env: sdkEnv,
            permissionMode: 'bypassPermissions' as const,
            allowDangerouslySkipPermissions: true,
            settingSources: ['project', 'user'] as const,
          },
        })) {
          if (message.type === 'assistant' && 'message' in message) {
            const content = (message as { message: { content: Array<{ type: string; text?: string }> } }).message.content;
            for (const block of content) {
              if (block.type === 'text' && block.text) summary += block.text;
            }
          }
          if (message.type === 'result' && 'result' in message) {
            const resultText = (message as { result?: string }).result;
            if (resultText) summary = resultText;
          }
        }
      } catch (err) {
        log(`Summary request failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      writeOutput({
        status: 'success',
        result: summary
          ? `Compactado. Resumen: ${summary}`
          : 'Conversation compacted.',
        newSessionId: slashSessionId,
      });
    } else if (!resultEmitted && !hadError) {
      writeOutput({
        status: 'success',
        result: compactBoundarySeen
          ? 'Conversation compacted.'
          : 'Compaction requested but compact_boundary was not observed.',
        newSessionId: slashSessionId,
      });
    } else if (!hadError) {
      // Emit session-only marker so host updates session tracking
      writeOutput({ status: 'success', result: null, newSessionId: slashSessionId });
    }
    return;
  }
  // --- End slash command handling ---

  // --- EXPERIMENT: auto-compact bloated sessions before first query ---
  // When a session .jsonl exceeds this size, we force /compact before
  // the real prompt so the model doesn't choke on megabytes of history.
  // Threshold: 1MB. Remove or adjust after evaluating results.
  const SESSION_SIZE_COMPACT_THRESHOLD = 20 * 1024 * 1024; // 20MB (jsonl is append-only and never shrinks after compact)
  if (sessionId) {
    const sessionFile = path.join(
      os.homedir(), '.claude', 'projects', '-workspace-group', `${sessionId}.jsonl`,
    );
    try {
      const stat = fs.statSync(sessionFile);
      if (stat.size > SESSION_SIZE_COMPACT_THRESHOLD) {
        const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
        log(`Session file is ${sizeMB}MB (>${SESSION_SIZE_COMPACT_THRESHOLD / 1024 / 1024}MB) — forcing /compact before query`);

        // Notify user before compacting
        const notifyData = {
          type: 'text',
          chatJid: containerInput.chatJid,
          text: `_Compactando sesión (${sizeMB}MB)… esto toma unos minutos._ ⏳`,
          groupFolder: containerInput.groupFolder,
          timestamp: new Date().toISOString(),
        };
        fs.mkdirSync(IPC_MESSAGES_DIR, { recursive: true });
        const notifyFile = path.join(IPC_MESSAGES_DIR, `${Date.now()}-compact-notify.json`);
        fs.writeFileSync(notifyFile, JSON.stringify(notifyData));

        for await (const message of query({
          prompt: '/compact',
          options: {
            cwd: '/workspace/group',
            resume: sessionId,
            systemPrompt: undefined,
            allowedTools: [],
            env: sdkEnv,
            permissionMode: 'bypassPermissions' as const,
            allowDangerouslySkipPermissions: true,
            settingSources: ['project', 'user'] as const,
            hooks: {
              PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
            },
          },
        })) {
          if (message.type === 'system' && message.subtype === 'init') {
            sessionId = message.session_id;
            log(`Session after auto-compact: ${sessionId}`);
          }
          if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
            log('Auto-compact completed');
          }
        }
        // Check new size
        try {
          const newStat = fs.statSync(sessionFile);
          log(`Session file after compact: ${(newStat.size / 1024 / 1024).toFixed(1)}MB`);
        } catch { /* file may have changed path after compact */ }
      } else {
        log(`Session file is ${(stat.size / 1024).toFixed(0)}KB — no compact needed`);
      }
    } catch {
      log(`Session file not found for ${sessionId} — skipping size check`);
    }
  }
  // --- END EXPERIMENT ---

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt);

      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
