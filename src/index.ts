import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_HAS_OWN_NUMBER,
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  DEFAULT_TRIGGER,
  GROUPS_DIR,
  getTriggerPattern,
  TRIGGER_PATTERN,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { NanoClawHandlers, startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import { FormmyWhatsAppChannel } from './channels/formmy-whatsapp.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  deleteRegisteredGroup,
  deleteSession,
  deleteTask,
  getTasksForGroup,
  getAllTasks,
  getChatPauseUntil,
  getLastBotMessageTimestamp,
  getMessageFromMe,
  getMessagesSince,
  hasManualModeSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  logUsage,
  getAllFormmyJids,
  getFormmyGroupFolder,
  getRegisteredGroupByFolder,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import { startSessionCleanup } from './session-cleanup.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { parseImageReferences } from './image.js';
import { recordPublicInputTokens } from './public-rate-limit.js';
import { StatusTracker } from './status-tracker.js';
import { logger } from './logger.js';
import { recordAgentInvocation } from './metrics.js';
import { initUsageReporter, reportTurnUsage } from './usage-reporter.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
// Tracks cursor value before messages were piped to an active container.
// Used to roll back if the container dies after piping.
let cursorBeforePipe: Record<string, string> = {};
let messageLoopRunning = false;

// Per-chat run-start timestamp. Used as the "since" bound for the output-time
// coexistence re-check (hasManualModeSince) — catches pauses applied AFTER
// spawn so an in-flight container's late outputs don't dump on the customer
// after the operator took over. Reset at processGroupMessages start.
const agentRunStartedAt: Record<string, string> = {};

// Per-chat count of MCP outbounds (send_message/image/document/audio/...)
// delivered during the current agent run. When >0, the result handler runs a
// narrow regex check on any trailing text — if it matches a known narration
// pattern ("Le envié al cliente…", "lead registrado en Kommo…"), it is
// dropped. Anything that doesn't match is delivered as-is so legitimate
// post-MCP follow-ups (bank details, invoice fields) survive. Bumped via
// IpcDeps.notifyMcpOutboundSent. Reset at processGroupMessages start.
//
// Why narrow regex instead of "drop all text after MCP outbound" (the
// approach e483bd1 took): the broad rule killed Luis Ordoñez's
// "transferencia OK, datos bancarios: Banamex…, para factura necesito RFC…"
// follow-up on 2026-05-12, which was real customer-facing content sent after
// a send_document. The narrow rule trips only on third-person/internal-tool
// markers that don't appear in legit customer-facing text.
const agentRunOutbound: Record<string, number> = {};

// Per-chat one-shot flag: when set, the next processGroupMessages run for that
// chat will bypass the manual_mode skip (Phase 2 of coexistence handoff). The
// flag is consumed (deleted) on read. Today the only writer is the
// `clear_coexistence_pause` IPC handler — when the admin agent releases an
// upstream pause, we want the worker chat to re-evaluate even if its pending
// messages still carry stale manual_mode=true flags from the pre-release
// webhooks. The agent then reads operator↔customer history (already in the
// formatMessages() XML) and decides whether to follow up.
const forceNextEvaluation = new Set<string>();
export function forceEvaluationOnce(chatJid: string): void {
  forceNextEvaluation.add(chatJid);
}

// Patterns that mark a `result.result` text as post-tool narration when an
// MCP outbound already landed in the same run. Keep narrow — anything that
// is even ambiguously customer-facing should NOT match.
//   - "le envié/mandé/pedí …"              → 3rd-person past-tense recap
//   - "lead/registro … Kommo"              → internal CRM mention (Enrique case)
//   - "esperando respuesta del cliente"    → 3rd-person waiting phrase
//   - "ya quedé a esperar …"               → meta statement about agent state
//   - "ya está en el chat"                → narration about a just-sent file
//   - "nota de voz enviada"                → recap of just-sent audio
// "ya está en el chat" is kept tight to avoid catching legit phrases like
// "tu paquete ya está enviado" — only the specific "ya está … en el chat"
// pattern is suppressed.
//
// The 3rd-person past-tense pattern was originally two narrower forms
// ("le V-é al cliente" + "ya le V-é"). The "ya le V-é\b" variant was
// effectively a no-op: JS regex `\b` is ASCII-only, so the trailing
// boundary never matched after the accented vowel (é/í) — confirmed
// 2026-05-13 when Sofi emitted "¡Listo! Le mandé los precios y le pedí
// los datos para proceder con la cotización" and nothing caught it.
// Broadened to an explicit verb list with NO trailing `\b` (alternation
// is exhaustive enough). isPostMcp gate prevents misfires.
const NARRATION_PATTERNS: readonly RegExp[] = [
  /\ble (envió|envié|mandó|mandé|compartió|compartí|pasó|pasé|pidió|pedí)/i,
  /\b(lead|registro)\b.*\bKommo\b/i,
  /\besperando.*\b(respuesta del cliente|su respuesta)\b/i,
  /\bya qued[ée] a?\s*esperar\b/i,
  /\bya está.{0,30}\ben el chat\b/i,
  /\bnota de voz (ya\s+)?enviad[oa]\b/i,
  /\bTodo listo\.\s+(Le\s+)?(mand[éó]|envi[éó]|compart[íi])\b/i,
  /\b(muev[oa]|movi[ée])\s+el\s+lead\b/i,
  /\bregistr[éo]\s+el\s+lead\b/i,
  /\b(cotizaci[oó]n|pdf|nota\s+de\s+voz|audio)\s+(ya\s+)?enviad[ao]\b/i,
];

function matchedNarrationPattern(text: string): string | null {
  for (const re of NARRATION_PATTERNS) {
    if (re.test(text)) return re.source;
  }
  return null;
}

const channels: Channel[] = [];
const queue = new GroupQueue();
let statusTracker: StatusTracker;

function pickReceivedEmoji(content: string): string {
  if (/^\[(Voice|Audio)\b/.test(content)) return '\u{1F442}';
  return '\u{1F440}';
}

// WABA 1:1 chats (Formmy bridge) have no trigger and aren't reactAlways, yet
// every customer message is for the bot — so status reactions (👀/✅) should
// always fire there, same as in groups. Single source of truth for both
// markReceived gates so they can't drift.
function isWabaJid(jid: string): boolean {
  return jid.startsWith('formmy_');
}

const STANDBY_IMAGE_PATH = path.join(
  process.cwd(),
  'assets',
  'technical-difficulties.jpg',
);
const STANDBY_COOLDOWN_MS = 5 * 60_000;
const lastStandbyAt: Record<string, number> = {};

function isApiOutageError(text: string): boolean {
  return (
    /^\s*API Error:\s*\d{3}/i.test(text) ||
    /\b(invalid_request_error|authentication_error|rate_limit_error|overloaded_error|api_error)\b/.test(
      text,
    ) ||
    /adaptive thinking is not supported/i.test(text) ||
    // Billing exhaustion: the Claude Code SDK surfaces an out-of-credit
    // account as a *synthetic* success result whose text is literally
    // "Credit balance is too low" (model "<synthetic>", $0 cost). Because it
    // arrives as status:success — not status:error — it sails past the fatal
    // classifier and the raw text would otherwise be sent verbatim to the
    // customer. Catch it here so it's replaced by the stand-by image instead
    // of exposing our billing state. Also matches the wrapped error variant
    // "Claude Code returned an error result: Credit balance is too low".
    /credit balance is too low/i.test(text) ||
    /^\s*Connection error\.?\s*$/i.test(text) ||
    /^\s*Bad Gateway\s*$/i.test(text) ||
    // Anthropic API response artifacts leaking as chat text (defensive).
    // Observed 2026-05-14 on sofi-0 after the coexistence stuck-skip fix:
    // a chat with a bad image got API 400 "Could not process image" → the
    // result.result string "API Error: 400 {...request_id:req_011Cb2h...}"
    // somehow reached the user as just `"req_011Cb2hWujV..."}` (tail only).
    // Root cause TBD. These guards catch any orphan Anthropic request_id
    // pattern OR the JSON-tail fragment pattern, so the agent-runner output
    // can never leak Anthropic API metadata to a customer chat.
    /"request_id"\s*:\s*"req_[A-Za-z0-9]{15,}"/.test(text) ||
    /^\s*"req_[A-Za-z0-9]{15,}"\s*}?\s*$/.test(text) ||
    /Could not process image/i.test(text)
  );
}

async function sendStandByImage(
  channel: Channel,
  chatJid: string,
  groupName: string,
  originalErrorText: string,
): Promise<void> {
  logger.warn(
    {
      group: groupName,
      errorPreview: originalErrorText.slice(0, 200),
    },
    'API outage detected — replacing error text with stand-by image',
  );
  const now = Date.now();
  if (
    lastStandbyAt[chatJid] &&
    now - lastStandbyAt[chatJid] < STANDBY_COOLDOWN_MS
  ) {
    logger.info({ chatJid }, 'Stand-by image suppressed (cooldown)');
    return;
  }
  lastStandbyAt[chatJid] = now;

  if (channel.sendImage && fs.existsSync(STANDBY_IMAGE_PATH)) {
    try {
      await channel.sendImage(
        chatJid,
        STANDBY_IMAGE_PATH,
        'Continuamos con atención personalizada',
      );
      return;
    } catch (err) {
      logger.warn({ err, chatJid }, 'sendImage failed, falling back to text');
    }
  }
  await channel.sendMessage(chatJid, 'Continuamos con atención personalizada');
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  const pipeCursor = getRouterState('cursor_before_pipe');
  try {
    cursorBeforePipe = pipeCursor ? JSON.parse(pipeCursor) : {};
  } catch {
    logger.warn('Corrupted cursor_before_pipe in DB, resetting');
    cursorBeforePipe = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
  setRouterState('cursor_before_pipe', JSON.stringify(cursorBeforePipe));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/** Strip <internal>/<thinking> reasoning blocks, tolerant of mismatched/unclosed tags. */
function stripInternalReasoning(raw: string): string {
  return raw
    .replace(/<(?:internal|thinking)>[\s\S]*?<\/(?:internal|thinking)>/gi, '')
    .replace(/<(?:internal|thinking)>[\s\S]*$/gi, '')
    .replace(/<\/?(?:internal|thinking)>/gi, '')
    .trim();
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  let group: RegisteredGroup | undefined = registeredGroups[chatJid];
  // Resolve formmy_ JIDs via folder mapping (same logic as message loop)
  if (!group) {
    const folder = getFormmyGroupFolder(chatJid);
    if (folder) {
      group = Object.values(registeredGroups).find((g) => g.folder === folder);
      if (!group) {
        const dbGroup = getRegisteredGroupByFolder(folder);
        if (dbGroup) {
          registeredGroups[dbGroup.jid] = dbGroup;
          group = dbGroup;
        }
      }
    }
  }
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // --- Session command interception (before trigger check) ---

  // Cross-group compact: `/compact <folder>` from main targets another group
  const cmdMsg = missedMessages.find(
    (m) => extractSessionCommand(m.content, TRIGGER_PATTERN) !== null,
  );
  if (cmdMsg && isMainGroup) {
    const cmd = extractSessionCommand(cmdMsg.content, TRIGGER_PATTERN)!;
    const crossMatch = cmd.match(/^\/compact\s+(\S+)$/);
    if (crossMatch) {
      const targetFolder = crossMatch[1];
      // Find target group by folder prefix match
      const targetEntry = Object.entries(registeredGroups).find(
        ([, g]) => g.folder === targetFolder || g.folder.includes(targetFolder),
      );
      if (!targetEntry) {
        await channel.sendMessage(
          chatJid,
          `Group "${targetFolder}" not found.`,
        );
      } else {
        const [targetJid, targetGroup] = targetEntry;
        // Kill active container for target group
        queue.closeStdin(targetJid);
        // Wait for container to die
        await new Promise((r) => setTimeout(r, 3000));
        // Gather stats for the confirmation message
        const targetMsgs = getMessagesSince(
          targetJid,
          lastAgentTimestamp[targetJid] || '',
          ASSISTANT_NAME,
        );
        const msgCount = targetMsgs.length;
        const hasSession = !!sessions[targetGroup.folder];
        await channel.sendMessage(
          chatJid,
          `Compacting ${targetGroup.name} (${msgCount} pending msgs, session: ${hasSession ? 'active' : 'none'})...`,
        );
        const compactResult = await runAgent(
          targetGroup,
          '/compact',
          targetJid,
          [],
          async (output) => {
            const text =
              typeof output.result === 'string'
                ? stripInternalReasoning(output.result)
                : '';
            if (text) await channel.sendMessage(chatJid, text);
          },
        );
        if (compactResult === 'error') {
          await channel.sendMessage(
            chatJid,
            `/compact ${targetGroup.name} failed.`,
          );
        }
      }
      // Advance cursor past all messages in batch
      const lastMsg = missedMessages[missedMessages.length - 1];
      lastAgentTimestamp[chatJid] = lastMsg.timestamp;
      saveState();
      return true;
    }
  }

  const cmdResult = await handleSessionCommand({
    missedMessages,
    isMainGroup,
    groupName: group.name,
    triggerPattern: TRIGGER_PATTERN,
    timezone: TIMEZONE,
    deps: {
      sendMessage: (text) => channel.sendMessage(chatJid, text),
      setTyping: (typing) =>
        channel.setTyping?.(chatJid, typing) ?? Promise.resolve(),
      runAgent: (prompt, onOutput) =>
        runAgent(group, prompt, chatJid, [], onOutput),
      closeStdin: () => queue.closeStdin(chatJid),
      advanceCursor: (ts) => {
        lastAgentTimestamp[chatJid] = ts;
        saveState();
      },
      formatMessages,
      canSenderInteract: (msg) => {
        const hasTrigger = TRIGGER_PATTERN.test(msg.content.trim());
        const reqTrigger = !isMainGroup && group.requiresTrigger !== false;
        return (
          isMainGroup ||
          !reqTrigger ||
          (hasTrigger &&
            ((ASSISTANT_HAS_OWN_NUMBER && msg.is_from_me) ||
              isTriggerAllowed(chatJid, msg.sender, loadSenderAllowlist())))
        );
      },
      clearSession: () => {
        delete sessions[group.folder];
        deleteSession(group.folder);
        logger.info(
          { group: group.name, folder: group.folder },
          'Session cleared via /clear',
        );
      },
    },
  });
  if (cmdResult.handled) return cmdResult.success;
  // --- End session command interception ---

  // Check if trigger is required and present (applies to any group with requiresTrigger)
  const needsTrigger =
    group.requiresTrigger !== false && group.trigger !== '.*';
  const triggerPattern = needsTrigger ? getTriggerPattern(group.trigger) : null;
  const stickerTrigger = group.containerConfig?.stickerTrigger !== false;
  const allowlistCfg = loadSenderAllowlist();
  const isInvokingMessage = (m: (typeof missedMessages)[number]): boolean => {
    if (!needsTrigger) return true;
    return (
      (triggerPattern!.test(m.content.trim()) ||
        (stickerTrigger && m.content.includes('[Sticker:'))) &&
      ((ASSISTANT_HAS_OWN_NUMBER && m.is_from_me) ||
        isTriggerAllowed(chatJid, m.sender, allowlistCfg))
    );
  };
  // Reactions (👀/✅) only fire when the message explicitly addresses the bot,
  // even in groups with requiresTrigger=false where every message processes.
  // Otherwise the bot reacts to human-to-human chatter and looks noisy.
  const explicitTriggerPattern =
    group.trigger !== '.*' ? getTriggerPattern(group.trigger) : null;
  const hasExplicitTrigger = (m: (typeof missedMessages)[number]): boolean => {
    if (!explicitTriggerPattern) return false;
    return (
      (explicitTriggerPattern.test(m.content.trim()) ||
        (stickerTrigger && m.content.includes('[Sticker:'))) &&
      ((ASSISTANT_HAS_OWN_NUMBER && m.is_from_me) ||
        isTriggerAllowed(chatJid, m.sender, allowlistCfg))
    );
  };
  if (needsTrigger) {
    const hasTrigger = missedMessages.some(isInvokingMessage);
    if (!hasTrigger) {
      return true;
    }
  }

  // Skip if only reactions (no actionable content)
  const actionableMessages = missedMessages.filter(
    (m) => !m.content.startsWith('[Reaction:'),
  );
  if (actionableMessages.length === 0) return true;

  // Coexistence gate (consolidated). Spawn the agent only when there's a
  // customer who is actually waiting: a customer message that is fresh,
  // not paused by Meta coexistence, and not already answered by an
  // operator/bot turn that came after it. Each rule maps to a real
  // failure observed on sofi-0 on 2026-05-14 after the coexistence
  // stuck-skip fix unblocked thousands of paused chats:
  //   - no-customer:       chat had only operator activity since the
  //                        last spawn → bot opened with "Buenos días X 😊"
  //                        unprompted.
  //   - manual_mode:       Meta marks the inbound while the owner is
  //                        replying from the linked phone → bot races
  //                        the operator.
  //   - operator-replied:  operator/bot answered the customer's last
  //                        input after it landed → re-evaluating just
  //                        produces meta-narration ("Esta conversación
  //                        ya está resuelta entre el Operador y X").
  //   - stale:             customer's last input is hours/days old →
  //                        re-engaging is intrusive.
  // forceEval (set by clear_coexistence_pause) bypasses all four — admin
  // explicit intent. Cursor advances on every skip so we don't re-scan
  // these messages on subsequent ticks.
  const forceEval = forceNextEvaluation.delete(chatJid);
  if (!forceEval) {
    const latestCustomerMsg = [...actionableMessages]
      .reverse()
      .find((m) => !m.is_from_me && !m.is_bot_message);
    const latestOperatorMsg = [...actionableMessages]
      .reverse()
      .find((m) => m.is_from_me && !m.is_bot_message);
    const latestMsg = actionableMessages[actionableMessages.length - 1];
    const STALE_MS = 60 * 60 * 1000;

    let skipReason: string | null = null;
    let extra: Record<string, number> = {};
    if (!latestCustomerMsg) {
      skipReason = 'no pending customer message';
    } else if (latestCustomerMsg.manual_mode === true) {
      skipReason = 'human takeover active (manual_mode)';
    } else if (
      latestOperatorMsg &&
      new Date(latestOperatorMsg.timestamp).getTime() >
        new Date(latestCustomerMsg.timestamp).getTime()
    ) {
      skipReason = 'operator replied after customer';
      extra.opLagMin = Math.round(
        (new Date(latestOperatorMsg.timestamp).getTime() -
          new Date(latestCustomerMsg.timestamp).getTime()) /
          60000,
      );
    } else {
      const custAgeMs =
        Date.now() - new Date(latestCustomerMsg.timestamp).getTime();
      if (custAgeMs > STALE_MS) {
        skipReason = 'last customer message too old';
        extra.custAgeMin = Math.round(custAgeMs / 60000);
      }
    }

    if (skipReason) {
      logger.info(
        { group: group.name, chatJid, skipReason, ...extra },
        'Skipped',
      );
      lastAgentTimestamp[chatJid] = latestMsg.timestamp;
      saveState();
      return true;
    }
  } else {
    logger.info(
      { group: group.name, chatJid },
      'Force-evaluating chat (coexistence release)',
    );
  }

  // Upstream pause gate: Formmy is authoritative about operator handoff and
  // ships the current `paused_until` on every inbound webhook (see
  // src/channels/formmy-whatsapp.ts inbound handler). Short-circuit BEFORE
  // spawning the agent — saves the full LLM inference (~$0.06+ per skipped
  // run on sofi-0, dominated by cache-read tokens). When the operator
  // unpauses upstream, the next inbound carries paused_until=null and the
  // channel clears the flag; this gate then lets the message through
  // normally. No deadlock: the source of truth is pushed on every message,
  // not learned from outbound failures.
  const pausedUntil = getChatPauseUntil(chatJid);
  if (pausedUntil && new Date(pausedUntil) > new Date()) {
    logger.info(
      { group: group.name, chatJid, pausedUntil },
      'Skipped (upstream pause active — no inference)',
    );
    // Advance the cursor so we don't re-process these messages when the
    // pause lifts. Persistence already happened in the channel handler.
    lastAgentTimestamp[chatJid] =
      missedMessages[missedMessages.length - 1].timestamp;
    saveState();
    return true;
  }

  // Ensure all user messages are tracked — recovery messages enter processGroupMessages
  // directly via the queue, bypassing startMessageLoop where markReceived normally fires.
  // markReceived is idempotent (rejects duplicates), so this is safe for normal-path messages too.
  // React only when the bot is explicitly addressed (trigger pattern present), so
  // groups with requiresTrigger=false don't get 👀/✅ on chatter between humans.
  // Exception: groups with reactAlways=true (demo groups where every message is
  // for the bot) react to every user message regardless of trigger.
  const reactAlways = group.containerConfig?.reactAlways === true;
  const wabaChat = isWabaJid(chatJid);
  for (const msg of actionableMessages) {
    if (msg.is_from_me || msg.is_bot_message) continue;
    if (!reactAlways && !wabaChat && !hasExplicitTrigger(msg)) continue;
    statusTracker.markReceived(
      msg.id,
      chatJid,
      false,
      msg.sender,
      pickReceivedEmoji(msg.content),
    );
  }

  // Mark all user messages as thinking (container is spawning)
  const userMessages = actionableMessages.filter(
    (m) => !m.is_from_me && !m.is_bot_message,
  );
  for (const msg of userMessages) {
    statusTracker.markThinking(msg.id);
  }

  const prompt = formatMessages(actionableMessages, TIMEZONE);
  const imageAttachments = parseImageReferences(actionableMessages);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = getOrRecoverCursor(chatJid);
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  // Check transcript size and suggest /compact if it's getting large
  const TRANSCRIPT_WARN_BYTES = 80 * 1024; // 80KB ≈ ~100K tokens after SDK overhead
  const transcriptDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
    'history',
  );
  if (fs.existsSync(transcriptDir)) {
    try {
      let totalSize = 0;
      for (const f of fs.readdirSync(transcriptDir)) {
        totalSize += fs.statSync(path.join(transcriptDir, f)).size;
      }
      if (totalSize > TRANSCRIPT_WARN_BYTES) {
        const sizeKB = Math.round(totalSize / 1024);
        logger.info(
          { group: group.name, sizeKB },
          'Transcript size above threshold, suggesting /compact',
        );
        await channel.sendMessage(
          chatJid,
          `_La sesión lleva ${sizeKB}KB de historial. Considera mandar /compact para reducir consumo de tokens._`,
        );
      }
    } catch {
      /* ignore stat errors */
    }
  }

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let lastErrorMessage = '';
  let outputSentToUser = false;
  let firstOutputSeen = false;

  // Capture run start so hasManualModeSince() can catch pauses applied
  // while the agent is mid-turn.
  agentRunStartedAt[chatJid] = new Date().toISOString();
  // Reset per-run MCP outbound counter so the narration filter only fires
  // for outbounds that landed in THIS run, not a previous one.
  agentRunOutbound[chatJid] = 0;

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    imageAttachments,
    async (result) => {
      // Streaming output callback — called for each agent result
      let sentTextThisResult = false;
      if (result.result) {
        if (!firstOutputSeen) {
          firstOutputSeen = true;
          for (const um of userMessages) {
            statusTracker.markWorking(um.id);
          }
        }
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>/<thinking> reasoning blocks (tolerant of mismatched/unclosed tags)
        const cleaned = stripInternalReasoning(raw);
        // Strip self-prefix the agent may add (e.g. "Ghosty: hello" → "hello").
        // Escape regex metacharacters first: Formmy/WABA chats register with
        // trigger_pattern ".*", which unescaped turned this into a greedy
        // `^(?:name|.*):` that ate the whole first line up to its last colon —
        // so any reply with a clock time ("...las 10:30 AM, ...") got truncated
        // to "30 AM, ...". This delivery path runs for every channel, so the
        // trigger must be treated as a literal here, not as a pattern.
        const escapeRe = (s: string) =>
          s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const triggerName = group.trigger.replace(/^@/, '');
        const prefixRe = new RegExp(
          `^(?:${escapeRe(ASSISTANT_NAME)}|${escapeRe(triggerName)}):\\s*`,
          'i',
        );
        const text = cleaned.replace(prefixRe, '').trim();
        // Filter out meta-responses where the agent says it won't respond.
        // The global CLAUDE.md tells agents to stay silent (wrap reasoning in
        // <internal>), but they sometimes leak a parenthetical explanation
        // anyway — observed in español on sofi-0 after the coexistence
        // wake-up fix unstuck WABA chats: "(Sin acción — solo saludos…)",
        // "(Esta conversación parece ser entre el equipo…)", "no requiere
        // respuesta de mi parte", etc. The customer doesn't need to see
        // these — drop them on the host side as defense-in-depth.
        // Stripped of surrounding parens/quotes first so the patterns match
        // both "(Sin acción…)" and bare "Sin acción…".
        const metaCandidate = text.replace(/^[\s("']+|[\s)"']+$/g, '').trim();
        const isMetaNoResponse =
          /^no\s+response\s+(needed|required|necessary)\.?$/i.test(text) ||
          /^(I don'?t need to|no need to|nothing to)\s+respond/i.test(text) ||
          /^sin\s+acci[oó]n\b/i.test(metaCandidate) ||
          /\bno\s+requiere\s+respuesta\b/i.test(metaCandidate) ||
          /\bno\s+(necesito|hace\s+falta|hay\s+que)\s+responder\b/i.test(
            metaCandidate,
          ) ||
          /\besta\s+conversaci[oó]n\s+(parece|es)\s+(entre|del?)\s+(el\s+)?equipo\b/i.test(
            metaCandidate,
          ) ||
          /\bquedo\s+(disponible|al\s+pendiente)\s+si\s+necesitan\b/i.test(
            metaCandidate,
          ) ||
          /\bdecid[ií]\s+no\s+(responder|contestar)\b/i.test(metaCandidate) ||
          /\b(me\s+quedo|prefiero)\s+(callad[oa]|en\s+silencio)\b/i.test(
            metaCandidate,
          );
        logger.info(
          { group: group.name },
          `Agent output: ${raw.length} chars${isMetaNoResponse ? ' (filtered: no-response-needed)' : ''}`,
        );
        // Suppression checks (cheapest first):
        //   a) paused-mid-run: pause was applied AFTER spawn; spawn-gate at
        //      L462 can't catch this. Re-query DB; if any manual_mode=1 since
        //      this run started, drop ALL remaining outputs.
        //   b) post-MCP narration: an MCP outbound already landed in this
        //      run AND the trailing text matches a narration pattern (3rd-
        //      person reference to "cliente", internal tool name like Kommo,
        //      "ya está en el chat" recap, etc). Narrow on purpose — anything
        //      that doesn't match passes through, so legitimate follow-ups
        //      like Luis Ordoñez's bank-details continuation after a PDF
        //      send_document are not affected. See agentRunOutbound docs.
        const startedAt = agentRunStartedAt[chatJid];
        const pausedMidRun =
          !!startedAt && hasManualModeSince(chatJid, startedAt);
        // isPostMcp kept for log context only — the gate produced a race with
        // the host IPC watcher (incident 2026-05-18, Sofi/Katya: narration emitted
        // before host processed PDF+audio IPC files, so counter was still 0 and
        // filter skipped). Current pattern list is specific enough to evaluate
        // unconditionally.
        const isPostMcp = (agentRunOutbound[chatJid] || 0) > 0;
        // Narration suppression is for WABA / customer-facing chats only. Admin
        // and internal Baileys groups (e.g. the cotizador admin chat with the
        // operator) legitimately discuss pipeline column names like "Cotización
        // enviada" that would otherwise false-positive the pattern and swallow a
        // real answer (incident 2026-05-23: tania created the Kommo pipeline but
        // its confirmation to the operator was suppressed).
        const isPublicChat =
          group.containerConfig?.profile === 'public' ||
          chatJid.startsWith('formmy_');
        const narrationMatch =
          isPublicChat && text ? matchedNarrationPattern(text) : null;
        if (text && !isMetaNoResponse && pausedMidRun) {
          logger.info(
            {
              group: group.name,
              chatJid,
              reason: 'paused-mid-run',
              preview: text.slice(0, 120),
            },
            'Agent output suppressed',
          );
        } else if (text && !isMetaNoResponse && narrationMatch) {
          logger.info(
            {
              group: group.name,
              chatJid,
              reason: 'post-mcp-narration',
              pattern: narrationMatch,
              preview: text.slice(0, 200),
            },
            'Agent output suppressed',
          );
        } else if (text && !isMetaNoResponse) {
          if (isApiOutageError(text)) {
            await sendStandByImage(channel, chatJid, group.name, text);
          } else {
            await channel.sendMessage(chatJid, text);
          }
          outputSentToUser = true;
          sentTextThisResult = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.usage) {
        const usageId = logUsage({
          group_folder: group.folder,
          chat_jid: chatJid,
          ...result.usage,
        });
        logger.info(
          {
            group: group.name,
            cost: result.usage.total_cost_usd,
            tokens: result.usage.input_tokens + result.usage.output_tokens,
          },
          'Usage logged',
        );

        // Feed input tokens (including cache reads) into the public rate
        // limiter so a single bloated turn counts toward the daily cap.
        if (group.containerConfig?.profile === 'public') {
          const inputTokens =
            result.usage.input_tokens +
            (result.usage.cache_creation_input_tokens ?? 0) +
            (result.usage.cache_read_input_tokens ?? 0);
          recordPublicInputTokens(chatJid, inputTokens);
        }

        // Push to ghosty.studio: only when we actually delivered a reply.
        // Tool-only turns (no text sent) are skipped per the reporter contract.
        const sessionId = sessions[group.folder];
        if (sentTextThisResult && sessionId && result.usage.model) {
          const lastUser = userMessages[userMessages.length - 1];
          reportTurnUsage({
            agent_group_id: group.folder,
            messaging_group_id: chatJid,
            session_id: sessionId,
            turn_idempotency_key: `${sessionId}:${usageId}`,
            model: result.usage.model,
            input_tokens: result.usage.input_tokens,
            output_tokens: result.usage.output_tokens,
            cache_creation_input_tokens:
              result.usage.cache_creation_input_tokens,
            cache_read_input_tokens: result.usage.cache_read_input_tokens,
            service_tier: result.usage.service_tier,
            occurred_at: new Date().toISOString(),
            user_id: lastUser?.sender,
          });
        }
      }

      if (result.status === 'success') {
        statusTracker.markAllDone(chatJid);
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
        lastErrorMessage = result.error || '';
      }
    },
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'fatal') {
    // Permanent error — retrying will never help, advance cursor
    return true;
  }

  if (output === 'error' || hadError) {
    if (outputSentToUser) {
      // Output was sent for the initial batch, so don't roll those back.
      // But if messages were piped AFTER that output, roll back to recover them.
      if (cursorBeforePipe[chatJid]) {
        lastAgentTimestamp[chatJid] = cursorBeforePipe[chatJid];
        delete cursorBeforePipe[chatJid];
        saveState();
        logger.warn(
          { group: group.name },
          'Agent error after output, rolled back piped messages for retry',
        );
        statusTracker.markAllFailed(chatJid);
        return false;
      }
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, no piped messages to recover',
      );
      statusTracker.markAllDone(chatJid);
      return true;
    }
    // No output sent — roll back everything so the full batch is retried
    lastAgentTimestamp[chatJid] = previousCursor;
    delete cursorBeforePipe[chatJid];
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    statusTracker.markAllFailed(chatJid);
    return false;
  }

  // Success — clear pipe tracking (markAllDone already fired in streaming callback)
  delete cursorBeforePipe[chatJid];
  saveState();
  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  imageAttachments: Array<{ relativePath: string; mediaType: string }>,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error' | 'fatal'> {
  // Métricas: timing de la invocación completa. Reportamos en TODOS los paths
  // de salida (return/throw) via wrapper interno para no manchar la lógica.
  const __metricsStart = Date.now();
  let __metricsStatus: 'success' | 'error' | 'fatal' = 'error';
  const __recordMetrics = () => {
    try {
      recordAgentInvocation(
        chatJid,
        group.folder,
        Date.now() - __metricsStart,
        __metricsStatus,
      );
    } catch {
      // Métrica no debe romper el flujo. Silenciamos.
    }
  };

  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId && output.status !== 'error') {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: group.trigger.replace(/^@/, '') || ASSISTANT_NAME,
        mcpServers: group.containerConfig?.mcpServers,
        allowedTools: group.containerConfig?.allowedTools,
        ...(imageAttachments.length > 0 && { imageAttachments }),
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId && output.status !== 'error') {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      // Permanent container errors — retrying will never help
      const fatalContainerPatterns = [
        'EACCES: permission denied',
        'Cannot find module',
        'not_found_error',
        'Could not resolve the model',
        'invalid_api_key',
        'Credit balance is too low',
        'authentication_error',
        // Autocompact thrashing: the SDK gives up when context refills to the
        // limit within a few turns of a compact, repeatedly. Retrying re-runs
        // the same doomed turn (e.g. an agent stuck retry-looping a tool that
        // keeps returning the same error), so treat it as fatal to break the
        // loop and advance the cursor. See "previous compact, N times in a row".
        'times in a row',
        'too large for the context window',
      ];
      if (
        output.error &&
        fatalContainerPatterns.some((p) => output.error!.includes(p))
      ) {
        logger.error(
          { group: group.name, error: output.error },
          'Fatal container error, skipping retry',
        );
        __metricsStatus = 'fatal';
        __recordMetrics();
        return 'fatal';
      }

      // Detect stale/corrupt session: the SDK throws ENOENT when the session
      // transcript file (.jsonl) doesn't exist inside the container. This
      // happens after container restarts since the filesystem is ephemeral.
      // Only clear + retry for this specific signal — transient errors
      // (network, API) should fall through to the normal backoff path.
      const isStaleSession =
        sessionId &&
        output.error &&
        /ENOENT.*\.jsonl|session.*not found|no conversation found/i.test(
          output.error,
        );

      if (isStaleSession) {
        logger.warn(
          {
            group: group.name,
            staleSessionId: sessionId,
            error: output.error,
          },
          'Stale session detected (ENOENT on session transcript) — clearing and retrying with fresh session',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);

        const freshOutput = await runContainerAgent(
          group,
          {
            prompt,
            sessionId: undefined,
            groupFolder: group.folder,
            chatJid,
            isMain,
            assistantName: group.trigger.replace(/^@/, '') || ASSISTANT_NAME,
            mcpServers: group.containerConfig?.mcpServers,
            allowedTools: group.containerConfig?.allowedTools,
            ...(imageAttachments.length > 0 && { imageAttachments }),
          },
          (proc, containerName) =>
            queue.registerProcess(chatJid, proc, containerName, group.folder),
          wrappedOnOutput,
        );

        if (freshOutput.newSessionId) {
          sessions[group.folder] = freshOutput.newSessionId;
          setSession(group.folder, freshOutput.newSessionId);
        }

        if (freshOutput.status === 'error') {
          logger.error(
            { group: group.name, error: freshOutput.error },
            'Container agent error on fresh session retry',
          );
          __metricsStatus = 'error';
          __recordMetrics();
          return 'error';
        }

        logger.info(
          { group: group.name, newSessionId: freshOutput.newSessionId },
          'Fresh session retry succeeded',
        );
        __metricsStatus = 'success';
        __recordMetrics();
        return 'success';
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      __metricsStatus = 'error';
      __recordMetrics();
      return 'error';
    }

    __metricsStatus = 'success';
    __recordMetrics();
    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    __metricsStatus = 'error';
    __recordMetrics();
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = [...Object.keys(registeredGroups), ...getAllFormmyJids()];
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          let group: RegisteredGroup | undefined = registeredGroups[chatJid];
          // Resolve formmy_ JIDs via jid mapping table
          if (!group) {
            const folder = getFormmyGroupFolder(chatJid);
            if (folder) {
              group = Object.values(registeredGroups).find(
                (g) => g.folder === folder,
              );
              // Hot-reload: group exists in DB but wasn't in memory at startup
              if (!group) {
                const dbGroup = getRegisteredGroupByFolder(folder);
                if (dbGroup) {
                  registeredGroups[dbGroup.jid] = dbGroup;
                  group = dbGroup;
                  logger.info(
                    { folder, jid: dbGroup.jid },
                    'Hot-reloaded group from DB',
                  );
                }
              }
            }
          }
          if (!group) {
            logger.warn(
              { chatJid, folder: getFormmyGroupFolder(chatJid) },
              'Skipping messages: no registered group found',
            );
            continue;
          }

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;

          // --- Session command interception (message loop) ---
          // Scan ALL messages in the batch for a session command.
          const loopCmdMsg = groupMessages.find(
            (m) => extractSessionCommand(m.content, TRIGGER_PATTERN) !== null,
          );

          if (loopCmdMsg) {
            // Only close active container if the sender is authorized — otherwise an
            // untrusted user could kill in-flight work by sending /compact (DoS).
            // closeStdin no-ops internally when no container is active.
            if (
              isSessionCommandAllowed(
                isMainGroup,
                loopCmdMsg.is_from_me === true,
              )
            ) {
              queue.closeStdin(chatJid);
              // Cross-group compact: also close target group's container
              const cmd = extractSessionCommand(
                loopCmdMsg.content,
                TRIGGER_PATTERN,
              );
              const crossMatch = cmd?.match(/^\/compact\s+(\S+)$/);
              if (crossMatch && isMainGroup) {
                const targetEntry = Object.entries(registeredGroups).find(
                  ([, g]) =>
                    g.folder === crossMatch[1] ||
                    g.folder.includes(crossMatch[1]),
                );
                if (targetEntry) queue.closeStdin(targetEntry[0]);
              }
            }
            // Enqueue so processGroupMessages handles auth + cursor advancement.
            // Don't pipe via IPC — slash commands need a fresh container with
            // string prompt (not MessageStream) for SDK recognition.
            queue.enqueueMessageCheck(chatJid);
            continue;
          }
          // --- End session command interception ---

          const needsTrigger =
            group.requiresTrigger !== false && group.trigger !== '.*';
          const triggerPattern = needsTrigger
            ? getTriggerPattern(group.trigger)
            : null;
          const stickerTrigger =
            group.containerConfig?.stickerTrigger !== false;
          const allowlistCfg = loadSenderAllowlist();
          const isInvokingMessage = (
            m: (typeof groupMessages)[number],
          ): boolean => {
            if (!needsTrigger) return true;
            return (
              (triggerPattern!.test(m.content.trim()) ||
                (stickerTrigger && m.content.includes('[Sticker:'))) &&
              ((ASSISTANT_HAS_OWN_NUMBER && m.is_from_me) ||
                isTriggerAllowed(chatJid, m.sender, allowlistCfg))
            );
          };
          const explicitTriggerPattern =
            group.trigger !== '.*' ? getTriggerPattern(group.trigger) : null;
          const hasExplicitTrigger = (
            m: (typeof groupMessages)[number],
          ): boolean => {
            if (!explicitTriggerPattern) return false;
            return (
              (explicitTriggerPattern.test(m.content.trim()) ||
                (stickerTrigger && m.content.includes('[Sticker:'))) &&
              ((ASSISTANT_HAS_OWN_NUMBER && m.is_from_me) ||
                isTriggerAllowed(chatJid, m.sender, allowlistCfg))
            );
          };

          // Only act on trigger messages when trigger is required.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const hasTrigger = groupMessages.some(isInvokingMessage);
            if (!hasTrigger) continue;
          }

          // React only when the bot is explicitly addressed (trigger pattern
          // present). Groups with requiresTrigger=false still process every
          // message internally, but reactions stay silent unless the user
          // says @bot/bot:. Exception: reactAlways=true demo groups react to
          // every user message.
          const reactAlways = group.containerConfig?.reactAlways === true;
          const wabaChat = isWabaJid(chatJid);
          for (const msg of groupMessages) {
            if (msg.is_from_me || msg.is_bot_message) continue;
            if (!reactAlways && !wabaChat && !hasExplicitTrigger(msg)) continue;
            statusTracker.markReceived(
              msg.id,
              chatJid,
              false,
              msg.sender,
              pickReceivedEmoji(msg.content),
            );
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          logger.info(
            { chatJid, group: group.name, msgCount: messagesToSend.length },
            'Dispatching messages to queue',
          );

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            // Mark new user messages as thinking (only groupMessages were markReceived'd;
            // accumulated allPending context messages are untracked and would no-op)
            for (const msg of groupMessages) {
              if (!msg.is_from_me && !msg.is_bot_message) {
                statusTracker.markThinking(msg.id);
              }
            }
            // Save cursor before first pipe so we can roll back if container dies
            if (!cursorBeforePipe[chatJid]) {
              cursorBeforePipe[chatJid] = lastAgentTimestamp[chatJid] || '';
            }
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  // Roll back any piped-message cursors that were persisted before a crash.
  // This ensures messages piped to a now-dead container are re-fetched.
  // IMPORTANT: Only roll back if the container is no longer running — rolling
  // back while the container is alive causes duplicate processing.
  let rolledBack = false;
  for (const [chatJid, savedCursor] of Object.entries(cursorBeforePipe)) {
    if (queue.isActive(chatJid)) {
      logger.debug(
        { chatJid },
        'Recovery: skipping piped-cursor rollback, container still active',
      );
      continue;
    }
    logger.info(
      { chatJid, rolledBackTo: savedCursor },
      'Recovery: rolling back piped-message cursor',
    );
    lastAgentTimestamp[chatJid] = savedCursor;
    delete cursorBeforePipe[chatJid];
    rolledBack = true;
  }
  if (rolledBack) {
    saveState();
  }

  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRemoteControl();
  initUsageReporter();

  // Start credential proxy (containers route API calls through this)
  const nanoClawHandlers: NanoClawHandlers = {};
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
    nanoClawHandlers,
  );

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    await statusTracker.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
    // Sync wake-up for channels that need to spawn processGroupMessages
    // immediately after writing a synthetic inbound (e.g. /trigger-reply),
    // without waiting for the 2s message-loop poll. Same reference IPC opts
    // already uses below.
    enqueueMessageCheck: (jid: string) => queue.enqueueMessageCheck(jid),
  };

  // Initialize status tracker (uses channels via callbacks, channels don't need to be connected yet)
  statusTracker = new StatusTracker({
    sendReaction: async (chatJid, messageKey, emoji) => {
      const channel = findChannel(channels, chatJid);
      if (!channel?.sendReaction) return;
      await channel.sendReaction(
        chatJid,
        messageKey.id,
        emoji,
        messageKey.participant,
      );
    },
    sendMessage: async (chatJid, text) => {
      const channel = findChannel(channels, chatJid);
      if (!channel) return;
      await channel.sendMessage(chatJid, text);
    },
    isMainGroup: (chatJid) => {
      const group = registeredGroups[chatJid];
      return group?.isMain === true;
    },
    isContainerAlive: (chatJid) => queue.isActive(chatJid),
  });

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  //
  // Connects fire in parallel with a 10s grace period: a channel whose .connect()
  // hangs (e.g. WhatsApp waiting on pairing) must not block other channels from
  // listening. The hung channel keeps trying in the background; if it eventually
  // succeeds it becomes functional, otherwise it stays unconnected but harmless.
  const connectPromises: Array<Promise<void>> = [];
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    connectPromises.push(
      channel.connect().catch((err) => {
        logger.warn(
          { err, channel: channelName },
          'Channel connect failed; service will continue without it',
        );
      }),
    );
  }
  if (channels.length === 0) {
    // Web-only mode: no inbound channels (WhatsApp/Slack/Telegram) configured,
    // but the admin-api /chat endpoint still serves messages from the
    // ghosty.studio web widget. Container-runner, credential-proxy and
    // group-queue all keep running below — only inbound polling is missing.
    logger.warn(
      'No inbound channels configured — running in web-only mode (admin-api /chat is the only entry point).',
    );
  }
  const CHANNEL_BOOT_GRACE_MS = 10_000;
  await Promise.race([
    Promise.all(connectPromises),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        logger.warn(
          { graceMs: CHANNEL_BOOT_GRACE_MS },
          'Channel boot grace expired; proceeding with whatever connected so far',
        );
        resolve();
      }, CHANNEL_BOOT_GRACE_MS),
    ),
  ]);

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
    logUsage,
  });
  // Wire up NanoClaw HTTP handlers now that channels are connected
  nanoClawHandlers.getInviteLink = async (jid) => {
    const channel = findChannel(channels, jid);
    if (!channel || !channel.getInviteLink) return null;
    return channel.getInviteLink(jid);
  };
  nanoClawHandlers.setJoinApproval = async (jid, mode) => {
    const channel = findChannel(channels, jid);
    if (!channel || !channel.setJoinApproval) {
      throw new Error('Channel does not support join approval toggle');
    }
    return channel.setJoinApproval(jid, mode);
  };
  nanoClawHandlers.createGroup = async (name) => {
    // Use first channel that supports group creation (currently only WhatsApp)
    const channel = channels.find((c) => typeof c.createGroup === 'function');
    if (!channel || !channel.createGroup) {
      throw new Error('No channel supports group creation');
    }
    const result = await channel.createGroup(name);
    // Auto-register the new group so the bot responds to messages there
    let folder = name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40);
    if (!folder) folder = `group_${Date.now()}`;
    // Avoid folder collisions by appending a suffix if one exists
    const existingFolders = new Set(
      Object.values(registeredGroups).map((g) => g.folder),
    );
    let uniqueFolder = folder;
    let suffix = 2;
    while (existingFolders.has(uniqueFolder)) {
      uniqueFolder = `${folder}_${suffix++}`;
    }
    registerGroup(result.jid, {
      name,
      folder: uniqueFolder,
      trigger: DEFAULT_TRIGGER,
      added_at: new Date().toISOString(),
      requiresTrigger: true,
      isMain: false,
    });
    // Set default group profile picture if configured
    const defaultPic = process.env.DEFAULT_GROUP_PROFILE_PIC;
    if (defaultPic && channel.updateProfilePicture) {
      try {
        const picPath = path.isAbsolute(defaultPic)
          ? defaultPic
          : path.join(GROUPS_DIR, defaultPic);
        if (fs.existsSync(picPath)) {
          await channel.updateProfilePicture(result.jid, picPath);
        } else {
          logger.warn({ picPath }, 'DEFAULT_GROUP_PROFILE_PIC not found');
        }
      } catch (err) {
        logger.warn(
          { err, jid: result.jid },
          'Failed to set default group pic',
        );
      }
    }
    return result;
  };

  nanoClawHandlers.leaveGroup = async (jid) => {
    const group = registeredGroups[jid];
    if (!group) {
      throw new Error(`Group ${jid} not registered`);
    }
    if (group.isMain === true) {
      throw new Error('Cannot leave the main group');
    }
    const folder = group.folder;

    // 1. Try to leave the group in WhatsApp (may fail if already kicked)
    let leftInWhatsApp = false;
    const channel = channels.find((c) => typeof c.leaveGroup === 'function');
    if (channel && channel.leaveGroup) {
      try {
        await channel.leaveGroup(jid);
        leftInWhatsApp = true;
      } catch (err) {
        logger.warn({ err, jid }, 'groupLeave failed (continuing cleanup)');
      }
    }

    // 2. Delete scheduled tasks
    const tasks = getTasksForGroup(folder);
    for (const t of tasks) deleteTask(t.id);

    // 3. Delete session
    deleteSession(folder);

    // 4. Unregister from DB + in-memory
    deleteRegisteredGroup(jid);
    delete registeredGroups[jid];

    // 5. Archive folder
    let archivedPath: string | null = null;
    try {
      const src = resolveGroupFolderPath(folder);
      if (fs.existsSync(src)) {
        const archiveBase = path.join(GROUPS_DIR, '_archived');
        fs.mkdirSync(archiveBase, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const dest = path.join(archiveBase, `${folder}-${stamp}`);
        fs.renameSync(src, dest);
        archivedPath = dest;
      }
    } catch (err) {
      logger.error({ err, folder }, 'Failed to archive group folder');
    }

    logger.info(
      { jid, folder, tasksDeleted: tasks.length, leftInWhatsApp, archivedPath },
      'Group left and cleaned up',
    );

    return {
      jid,
      folder,
      archivedPath,
      tasksDeleted: tasks.length,
      leftInWhatsApp,
    };
  };

  nanoClawHandlers.listArchivedGroups = async () => {
    const archiveBase = path.join(GROUPS_DIR, '_archived');
    if (!fs.existsSync(archiveBase)) return [];
    const entries = fs.readdirSync(archiveBase, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => {
        // Folder format: <originalFolder>-<ISO-timestamp-with-dashes>
        // Timestamp has 3 dashes in the date portion, then -T...; find the split
        const m = e.name.match(/^(.+)-(\d{4}-\d{2}-\d{2}T.+)$/);
        const originalFolder = m ? m[1] : e.name;
        const archivedAt = m ? m[2] : '';
        return { archivedFolder: e.name, originalFolder, archivedAt };
      })
      .sort((a, b) => b.archivedFolder.localeCompare(a.archivedFolder));
  };

  nanoClawHandlers.restoreGroup = async (
    archivedFolder,
    jid,
    name,
    trigger,
  ) => {
    const archiveBase = path.join(GROUPS_DIR, '_archived');
    const src = path.join(archiveBase, archivedFolder);
    // Security: ensure src is strictly inside _archived/
    if (!src.startsWith(archiveBase + path.sep) || !fs.existsSync(src)) {
      throw new Error(`Archived folder not found: ${archivedFolder}`);
    }
    // Derive original folder name (strip the -ISO-timestamp suffix)
    const m = archivedFolder.match(/^(.+)-\d{4}-\d{2}-\d{2}T.+$/);
    const originalFolder = m ? m[1] : archivedFolder;
    if (!originalFolder || originalFolder.includes('/')) {
      throw new Error(`Invalid original folder derived: ${originalFolder}`);
    }
    // Avoid collision with an existing active group folder
    const existingFolders = new Set(
      Object.values(registeredGroups).map((g) => g.folder),
    );
    let folder = originalFolder;
    let suffix = 2;
    while (existingFolders.has(folder)) {
      folder = `${originalFolder}_${suffix++}`;
    }
    const dest = resolveGroupFolderPath(folder);
    if (fs.existsSync(dest)) {
      throw new Error(`Destination folder already exists: ${folder}`);
    }
    fs.renameSync(src, dest);
    registerGroup(jid, {
      name,
      folder,
      trigger,
      added_at: new Date().toISOString(),
      requiresTrigger: true,
      isMain: false,
    });
    logger.info(
      { jid, folder, restoredFrom: archivedFolder },
      'Group restored',
    );
    return { jid, folder, restoredFrom: archivedFolder };
  };

  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    sendImage: (jid, filePath, caption, isUrl) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (channel.sendImage) {
        return channel.sendImage(jid, filePath, caption, isUrl);
      }
      // Fallback: send caption as text if channel doesn't support images
      return channel.sendMessage(
        jid,
        caption || '[Image not supported on this channel]',
      );
    },
    sendReaction: async (jid, messageId, emoji) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (messageId) {
        if (!channel.sendReaction) {
          logger.warn(
            { jid, emoji, channel: channel.constructor?.name },
            'Channel does not support sendReaction — skipping',
          );
          return;
        }
        await channel.sendReaction(jid, messageId, emoji);
      } else {
        if (!channel.reactToLatestMessage) {
          logger.warn(
            { jid, emoji, channel: channel.constructor?.name },
            'Channel does not support reactToLatestMessage — skipping',
          );
          return;
        }
        await channel.reactToLatestMessage(jid, emoji);
      }
    },
    sendDocument: (jid, filePath, filename, caption) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (channel.sendDocument) {
        return channel.sendDocument(jid, filePath, filename, caption);
      }
      return channel.sendMessage(
        jid,
        caption || '[Document not supported on this channel]',
      );
    },
    sendLocation: (jid, latitude, longitude, name, address) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (channel.sendLocation) {
        return channel.sendLocation(jid, latitude, longitude, name, address);
      }
      // Fallback: send a Google Maps link so the user still gets the point.
      const link = `https://maps.google.com/?q=${latitude},${longitude}`;
      const label = name ? `${name}\n` : '';
      const addr = address ? `${address}\n` : '';
      return channel.sendMessage(jid, `${label}${addr}${link}`);
    },
    sendCtaUrl: (jid, text, url, buttonText) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (channel.sendCtaUrl) {
        return channel.sendCtaUrl(jid, text, url, buttonText);
      }
      // Fallback: plain text with the URL so the link still reaches the user.
      const body = text ? `${text}\n${url}` : url;
      return channel.sendMessage(jid, body);
    },
    sendContact: (jid, name, phone) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (channel.sendContact) {
        return channel.sendContact(jid, name, phone);
      }
      // Fallback: plain text contact line.
      return channel.sendMessage(jid, `${name}: ${phone}`);
    },
    sendVideo: (jid, filePath, caption) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (channel.sendVideo) {
        return channel.sendVideo(jid, filePath, caption);
      }
      // Fallback: send as document if channel doesn't support native video
      if (channel.sendDocument) {
        return channel.sendDocument(
          jid,
          filePath,
          filePath.split('/').pop() || 'video.mp4',
          caption,
        );
      }
      return channel.sendMessage(
        jid,
        caption || '[Video not supported on this channel]',
      );
    },
    sendSticker: (jid, filePath) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (channel.sendSticker) {
        return channel.sendSticker(jid, filePath);
      }
      return Promise.resolve();
    },
    sendPoll: (jid, name, options, selectableCount) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (channel.sendPoll) {
        return channel.sendPoll(jid, name, options, selectableCount);
      }
      // Fallback: send poll as numbered text list
      const list = options.map((o, i) => `${i + 1}. ${o}`).join('\n');
      return channel.sendMessage(jid, `📊 ${name}\n${list}`);
    },
    sendAudio: (jid, filePath) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (channel.sendAudio) {
        return channel.sendAudio(jid, filePath);
      }
      return Promise.resolve();
    },
    updateProfilePicture: async (jid, filePath) => {
      const channel = findChannel(channels, jid);
      if (channel?.updateProfilePicture) {
        await channel.updateProfilePicture(jid, filePath);
      } else {
        logger.warn({ jid }, 'No channel supports updateProfilePicture');
      }
    },
    updateGroupName: async (jid, name) => {
      const channel = findChannel(channels, jid);
      if (channel?.updateGroupName) {
        await channel.updateGroupName(jid, name);
      } else {
        logger.warn({ jid }, 'No channel supports updateGroupName');
      }
    },
    releaseCoexistence: async (jid) => {
      // Coexistence is a Formmy/WABA-specific concept (upstream bridge owns the
      // manual_mode timer). The generic Channel interface intentionally does NOT
      // know about it — native channels like Baileys, Telegram, Slack, Discord
      // have no business with coexistence state. Resolve the Formmy channel by
      // name and call its method directly.
      const formmyChannel = channels.find(
        (c): c is FormmyWhatsAppChannel => c.name === 'formmy-whatsapp',
      );
      if (!formmyChannel) {
        throw new Error('Formmy channel not connected — cannot release pause');
      }
      if (!formmyChannel.ownsJid(jid)) {
        throw new Error(`JID ${jid} is not a Formmy/WABA JID`);
      }
      await formmyChannel.releaseCoexistence(jid);
    },
    setConversationTag: async (jid, action, label, color, comment) => {
      // Conversation tags live on the Formmy side (ConvoTag embedded in
      // Conversation). Same dispatch rationale as releaseCoexistence: WABA-only
      // feature, generic Channel interface doesn't carry it.
      const formmyChannel = channels.find(
        (c): c is FormmyWhatsAppChannel => c.name === 'formmy-whatsapp',
      );
      if (!formmyChannel) {
        throw new Error('Formmy channel not connected — cannot set tag');
      }
      if (!formmyChannel.ownsJid(jid)) {
        throw new Error(`JID ${jid} is not a Formmy/WABA JID`);
      }
      await formmyChannel.setConversationTag(
        jid,
        action,
        label,
        color,
        comment,
      );
    },
    notifyMcpOutboundSent: (jid) => {
      agentRunOutbound[jid] = (agentRunOutbound[jid] || 0) + 1;
    },
    forceEvaluationOnce: (jid) => {
      forceEvaluationOnce(jid);
    },
    enqueueMessageCheck: (jid) => {
      queue.enqueueMessageCheck(jid);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
    statusHeartbeat: () => statusTracker.heartbeatCheck(),
    recoverPendingMessages,
  });
  // Recover status tracker AFTER channels connect, so recovery reactions
  // can actually be sent via the WhatsApp channel.
  await statusTracker.recover();
  startSessionCleanup();
  queue.setProcessMessagesFn(processGroupMessages);
  const lastErrorSentAt: Record<string, number> = {};
  queue.setOnRetriesExhausted((groupJid) => {
    const now = Date.now();
    if (
      lastErrorSentAt[groupJid] &&
      now - lastErrorSentAt[groupJid] < 5 * 60_000
    ) {
      logger.info(
        { groupJid },
        'Suppressing repeated error message to channel',
      );
      return;
    }
    lastErrorSentAt[groupJid] = now;
    const group = registeredGroups[groupJid];
    if (!group) return;
    // Auto-clear stale sessionId so the next message starts fresh instead of
    // resuming a session the SDK may have lost (common failure mode).
    try {
      deleteSession(group.folder);
      logger.info(
        { groupJid, groupFolder: group.folder },
        'Cleared session after retries exhausted — next message will start fresh',
      );
    } catch (err) {
      logger.warn({ groupJid, err }, 'Failed to clear session after cooldown');
    }
    const channel = findChannel(channels, groupJid);
    if (!channel) return;
    channel
      .sendMessage(
        groupJid,
        '_Entré en enfriamiento 5 min tras varios errores. Reinicié la sesión; vuelve a intentar en unos minutos._',
      )
      .catch(() => {});
  });
  recoverPendingMessages();

  // Write group/task snapshots at startup so containers always have fresh data
  const startupGroups = getAvailableGroups();
  const startupRegisteredJids = new Set(Object.keys(registeredGroups));
  const startupTasks = getAllTasks().map((t) => ({
    id: t.id,
    groupFolder: t.group_folder,
    prompt: t.prompt,
    schedule_type: t.schedule_type,
    schedule_value: t.schedule_value,
    status: t.status,
    next_run: t.next_run,
  }));
  for (const group of Object.values(registeredGroups)) {
    const im = group.isMain === true;
    writeGroupsSnapshot(group.folder, im, startupGroups, startupRegisteredJids);
    writeTasksSnapshot(group.folder, im, startupTasks);
  }

  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
