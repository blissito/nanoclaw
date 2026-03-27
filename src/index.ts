import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  TRIGGER_PATTERN,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { NanoClawHandlers, startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
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
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessageFromMe,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  clearSession,
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
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { parseImageReferences } from './image.js';
import { StatusTracker } from './status-tracker.js';
import { logger } from './logger.js';

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


const channels: Channel[] = [];
const queue = new GroupQueue();
let statusTracker: StatusTracker;

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
                ? output.result
                    .replace(/<internal>[\s\S]*?<\/internal>/g, '')
                    .trim()
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
            (msg.is_from_me ||
              isTriggerAllowed(chatJid, msg.sender, loadSenderAllowlist())))
        );
      },
    },
  });
  if (cmdResult.handled) return cmdResult.success;
  // --- End session command interception ---

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        (triggerPattern.test(m.content.trim()) ||
          m.content.includes('[Sticker:')) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) {
      return true;
    }
  }

  // Skip if only reactions (no actionable content)
  const actionableMessages = missedMessages.filter(
    (m) => !m.content.startsWith('[Reaction:'),
  );
  if (actionableMessages.length === 0) return true;

  // Coexistence: skip response if human agent has taken over (Formmy manual_mode)
  const hasManualMode = actionableMessages.some((m) => m.manual_mode);
  if (hasManualMode) {
    logger.info(
      { group: group.name, chatJid },
      'Skipped (human takeover active — manual_mode)',
    );
    return true;
  }

  // Ensure all user messages are tracked — recovery messages enter processGroupMessages
  // directly via the queue, bypassing startMessageLoop where markReceived normally fires.
  // markReceived is idempotent (rejects duplicates), so this is safe for normal-path messages too.
  for (const msg of actionableMessages) {
    statusTracker.markReceived(msg.id, chatJid, false);
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

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    imageAttachments,
    async (result) => {
      // Streaming output callback — called for each agent result
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
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const cleaned = raw
          .replace(/<internal>[\s\S]*?<\/internal>/g, '')
          .trim();
        // Strip self-prefix the agent may add (e.g. "Ghosty: hello" → "hello")
        const triggerName = group.trigger.replace(/^@/, '');
        const prefixRe = new RegExp(
          `^(?:${ASSISTANT_NAME}|${triggerName}):\\s*`,
          'i',
        );
        const text = cleaned.replace(prefixRe, '').trim();
        logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
        if (text) {
          await channel.sendMessage(chatJid, text);
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.usage) {
        logUsage({
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
        statusTracker.markAllFailed(chatJid, 'Task crashed — retrying.');
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
    statusTracker.markAllFailed(chatJid, 'Task crashed — retrying.');
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
        if (output.newSessionId) {
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
        'authentication_error',
      ];
      if (
        output.error &&
        fatalContainerPatterns.some((p) => output.error!.includes(p))
      ) {
        logger.error(
          { group: group.name, error: output.error },
          'Fatal container error, skipping retry',
        );
        return 'fatal';
      }

      // Detect stale/corrupt session: container failed while resuming an existing session.
      // Clear the session and retry once with a fresh session to avoid infinite retry loops.
      if (sessionId) {
        logger.warn(
          {
            group: group.name,
            staleSessionId: sessionId,
            error: output.error,
          },
          'Container failed with existing session — clearing stale session and retrying with fresh session',
        );
        delete sessions[group.folder];
        clearSession(group.folder);

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
          return 'error';
        }

        logger.info(
          { group: group.name, newSessionId: freshOutput.newSessionId },
          'Fresh session retry succeeded',
        );
        return 'success';
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
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

          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                (triggerPattern.test(m.content.trim()) ||
                  m.content.includes('[Sticker:')) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Mark each user message as received (status emoji)
          for (const msg of groupMessages) {
            if (!msg.is_from_me && !msg.is_bot_message) {
              statusTracker.markReceived(msg.id, chatJid, false);
            }
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
  };

  // Initialize status tracker (uses channels via callbacks, channels don't need to be connected yet)
  statusTracker = new StatusTracker({
    sendReaction: async (chatJid, messageKey, emoji) => {
      const channel = findChannel(channels, chatJid);
      if (!channel?.sendReaction) return;
      await channel.sendReaction(chatJid, messageKey.id, emoji);
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
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

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

  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    sendImage: (jid, filePath, caption) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (channel.sendImage) {
        return channel.sendImage(jid, filePath, caption);
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
        if (!channel.sendReaction)
          throw new Error('Channel does not support sendReaction');
        await channel.sendReaction(jid, messageId, emoji);
      } else {
        if (!channel.reactToLatestMessage)
          throw new Error('Channel does not support reactions');
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
    const channel = findChannel(channels, groupJid);
    if (!channel) return;
    channel
      .sendMessage(
        groupJid,
        '_No pude procesar los mensajes anteriores después de varios intentos. Por favor reenvíen._',
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
