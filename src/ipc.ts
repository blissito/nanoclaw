import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  FORMMY_TRAINING_GROUP_FOLDER,
  GROUPS_DIR,
  IPC_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import {
  createTask,
  deleteTask,
  getTaskById,
  storeMessageDirect,
  trackImageGeneration,
  updateTask,
} from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { isTaskRunning } from './task-scheduler.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendImage: (jid: string, filePath: string, caption: string) => Promise<void>;
  sendReaction: (
    jid: string,
    messageId: string | undefined,
    emoji: string,
    participant?: string,
  ) => Promise<void>;
  sendAudio: (jid: string, filePath: string) => Promise<void>;
  sendVideo: (jid: string, filePath: string, caption: string) => Promise<void>;
  sendSticker: (jid: string, filePath: string) => Promise<void>;
  sendPoll: (
    jid: string,
    name: string,
    options: string[],
    selectableCount: number,
  ) => Promise<void>;
  sendDocument: (
    jid: string,
    filePath: string,
    filename: string,
    caption: string,
  ) => Promise<void>;
  sendLocation: (
    jid: string,
    latitude: number,
    longitude: number,
    name: string | undefined,
    address: string | undefined,
  ) => Promise<void>;
  /**
   * Signal that an outbound message/media was sent for this chat via the
   * agent's MCP tools (send_message, send_image, etc.). The agent-run handler
   * uses this to gate a narrow regex check on trailing text outputs Claude
   * tends to emit ("Le envié al cliente la foto…", "Lead registrado en
   * Kommo…"). The check fires only when an MCP outbound already landed AND
   * the trailing text matches one of the narration patterns — anything that
   * doesn't match the patterns is delivered as-is, so legitimate post-PDF
   * follow-ups (bank details, invoice fields) survive.
   * Idempotent — fire on every successful outbound.
   */
  notifyMcpOutboundSent?: (jid: string) => void;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  updateProfilePicture: (jid: string, filePath: string) => Promise<void>;
  updateGroupName: (jid: string, name: string) => Promise<void>;
  releaseCoexistence: (jid: string) => Promise<void>;
  /**
   * Mark a chat to bypass the coexistence (manual_mode) skip on its next
   * processGroupMessages run. Used after `releaseCoexistence` to wake the
   * agent so it reads the operator↔customer history and decides whether to
   * follow up. The flag is consumed once; no synthetic message is injected.
   */
  forceEvaluationOnce?: (jid: string) => void;
  /**
   * Enqueue a single check of this chat through the GroupQueue. Same path the
   * message loop uses on every tick; idempotent and serialized per-chat.
   */
  enqueueMessageCheck?: (jid: string) => void;
  setConversationTag: (
    jid: string,
    action: 'add' | 'remove',
    label: string,
    color: string | undefined,
    comment: string | undefined,
  ) => Promise<void>;
  onTasksChanged: () => void;
  statusHeartbeat?: () => void;
  recoverPendingMessages?: () => void;
}

let ipcWatcherRunning = false;
const RECOVERY_INTERVAL_MS = 60_000;

// Public-profile groups get the training group's root files bind-mounted at
// /workspace/group/<file> read-only (see container-runner.ts). The container
// runtime auto-creates 0-byte mount-target stubs in the per-customer host
// folder. send_message with `document_path` (or any media) round-trips through
// the host IPC, which reads from the host folder — and would read the 0-byte
// stub, sending an empty file. Detect that case and re-resolve to the real
// training file. Only applies when subdir is empty (the overlay never mounts
// subdirectories) and the target group is public-profile.
function resolveMediaPath(
  folder: string,
  subdir: string,
  filename: string,
  targetGroup: RegisteredGroup | undefined,
): string {
  const perGroupPath = subdir
    ? path.join(GROUPS_DIR, folder, subdir, filename)
    : path.join(GROUPS_DIR, folder, filename);
  if (
    subdir ||
    !FORMMY_TRAINING_GROUP_FOLDER ||
    targetGroup?.containerConfig?.profile !== 'public'
  ) {
    return perGroupPath;
  }
  try {
    if (fs.statSync(perGroupPath).size > 0) return perGroupPath;
  } catch {
    return perGroupPath;
  }
  const trainingPath = path.join(
    GROUPS_DIR,
    FORMMY_TRAINING_GROUP_FOLDER,
    filename,
  );
  try {
    if (fs.statSync(trainingPath).size > 0) return trainingPath;
  } catch {
    // training file missing — fall through with stub path
  }
  return perGroupPath;
}

function fileSizeOrUndef(p: string): number | undefined {
  try {
    return fs.statSync(p).size;
  } catch {
    return undefined;
  }
}

// Persist an audit row for outbound media. Without this, messages.db only
// reflects inbound + text outbound; image/document/audio/video/sticker sent
// by the agent are invisible to history queries (incident 2026-05-18: Sofi
// claimed to have sent a photo, DB only showed her text — looked like
// hallucination until session.jsonl confirmed the send). Marker mirrors the
// inbound format from whatsapp.ts (`[image: attachments/...]`).
function recordOutboundMedia(
  chatJid: string,
  type: 'image' | 'document' | 'audio' | 'video' | 'sticker',
  filename: string,
  subdir: string | undefined,
  caption: string | undefined,
): void {
  try {
    const subPart = subdir ? `${subdir}/` : 'attachments/';
    const marker = `[${type}: ${subPart}${filename}]`;
    const content = caption ? `${caption}\n\n${marker}` : marker;
    storeMessageDirect({
      id: `bot-media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chat_jid: chatJid,
      sender: 'agent',
      sender_name: 'Agente',
      content,
      timestamp: new Date().toISOString(),
      is_from_me: true,
      is_bot_message: true,
    });
  } catch (err) {
    logger.warn(
      { err, chatJid, type, filename },
      'storeMessageDirect failed for outbound media',
    );
  }
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });
  let lastRecoveryTime = Date.now();

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  deps.notifyMcpOutboundSent?.(data.chatJid);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              } else if (
                data.type === 'reaction' &&
                data.chatJid &&
                data.messageId &&
                data.emoji
              ) {
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  try {
                    await deps.sendReaction(
                      data.chatJid,
                      data.messageId,
                      data.emoji,
                      data.participant,
                    );
                    logger.info(
                      {
                        chatJid: data.chatJid,
                        sourceGroup,
                        emoji: data.emoji,
                      },
                      'IPC reaction sent',
                    );
                  } catch (err) {
                    logger.error(
                      {
                        chatJid: data.chatJid,
                        emoji: data.emoji,
                        sourceGroup,
                        err,
                      },
                      'IPC reaction failed',
                    );
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC reaction attempt blocked',
                  );
                }
              } else if (
                data.type === 'audio' &&
                data.chatJid &&
                data.filename
              ) {
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  if (
                    data.filename.includes('/') ||
                    data.filename.includes('..')
                  ) {
                    logger.warn(
                      { filename: data.filename, sourceGroup },
                      'Rejected audio with unsafe filename',
                    );
                  } else {
                    const folder = targetGroup?.folder || sourceGroup;
                    const subdir =
                      data.subdir &&
                      !data.subdir.startsWith('/') &&
                      !data.subdir.includes('..')
                        ? data.subdir
                        : '';
                    const absPath = resolveMediaPath(
                      folder,
                      subdir,
                      data.filename,
                      targetGroup,
                    );
                    const bytes = fileSizeOrUndef(absPath);
                    await deps.sendAudio(data.chatJid, absPath);
                    deps.notifyMcpOutboundSent?.(data.chatJid);
                    recordOutboundMedia(
                      data.chatJid,
                      'audio',
                      data.filename,
                      subdir,
                      undefined,
                    );
                    logger.info(
                      {
                        chatJid: data.chatJid,
                        sourceGroup,
                        filename: data.filename,
                        bytes,
                      },
                      'IPC audio sent',
                    );
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC audio attempt blocked',
                  );
                }
              } else if (
                data.type === 'video' &&
                data.chatJid &&
                data.filename
              ) {
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  if (
                    data.filename.includes('/') ||
                    data.filename.includes('..')
                  ) {
                    logger.warn(
                      { filename: data.filename, sourceGroup },
                      'Rejected video with unsafe filename',
                    );
                  } else {
                    const folder = targetGroup?.folder || sourceGroup;
                    const subdir =
                      data.subdir &&
                      !data.subdir.startsWith('/') &&
                      !data.subdir.includes('..')
                        ? data.subdir
                        : '';
                    const absPath = resolveMediaPath(
                      folder,
                      subdir,
                      data.filename,
                      targetGroup,
                    );
                    const bytes = fileSizeOrUndef(absPath);
                    await deps.sendVideo(
                      data.chatJid,
                      absPath,
                      data.caption || '',
                    );
                    deps.notifyMcpOutboundSent?.(data.chatJid);
                    recordOutboundMedia(
                      data.chatJid,
                      'video',
                      data.filename,
                      subdir,
                      data.caption,
                    );
                    logger.info(
                      {
                        chatJid: data.chatJid,
                        sourceGroup,
                        filename: data.filename,
                        bytes,
                      },
                      'IPC video sent',
                    );
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC video attempt blocked',
                  );
                }
              } else if (
                data.type === 'sticker' &&
                data.chatJid &&
                data.filename
              ) {
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  if (
                    data.filename.includes('/') ||
                    data.filename.includes('..')
                  ) {
                    logger.warn(
                      { filename: data.filename, sourceGroup },
                      'Rejected sticker with unsafe filename',
                    );
                  } else {
                    const folder = targetGroup?.folder || sourceGroup;
                    // Support subdir (e.g. "stickers") for organized file storage
                    const subdir =
                      data.subdir &&
                      !data.subdir.includes('/') &&
                      !data.subdir.includes('..')
                        ? data.subdir
                        : '';
                    const absPath = resolveMediaPath(
                      folder,
                      subdir,
                      data.filename,
                      targetGroup,
                    );
                    const bytes = fileSizeOrUndef(absPath);
                    await deps.sendSticker(data.chatJid, absPath);
                    deps.notifyMcpOutboundSent?.(data.chatJid);
                    recordOutboundMedia(
                      data.chatJid,
                      'sticker',
                      data.filename,
                      subdir,
                      undefined,
                    );
                    logger.info(
                      {
                        chatJid: data.chatJid,
                        sourceGroup,
                        filename: data.filename,
                        bytes,
                      },
                      'IPC sticker sent',
                    );
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC sticker attempt blocked',
                  );
                }
              } else if (
                data.type === 'poll' &&
                data.chatJid &&
                typeof data.name === 'string' &&
                Array.isArray(data.options) &&
                data.options.length >= 2
              ) {
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  const options = (data.options as unknown[])
                    .map((o) => (typeof o === 'string' ? o : ''))
                    .filter((o) => o.length > 0)
                    .slice(0, 12);
                  if (options.length < 2) {
                    logger.warn(
                      { sourceGroup, chatJid: data.chatJid },
                      'Rejected poll with fewer than 2 valid options',
                    );
                  } else {
                    const rawCount =
                      typeof data.selectableCount === 'number'
                        ? data.selectableCount
                        : 1;
                    const selectableCount = Math.max(
                      1,
                      Math.min(rawCount, options.length),
                    );
                    await deps.sendPoll(
                      data.chatJid,
                      data.name,
                      options,
                      selectableCount,
                    );
                    deps.notifyMcpOutboundSent?.(data.chatJid);
                    logger.info(
                      {
                        chatJid: data.chatJid,
                        sourceGroup,
                        options: options.length,
                        selectableCount,
                      },
                      'IPC poll sent',
                    );
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC poll attempt blocked',
                  );
                }
              } else if (
                data.type === 'location' &&
                data.chatJid &&
                typeof data.latitude === 'number' &&
                typeof data.longitude === 'number'
              ) {
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendLocation(
                    data.chatJid,
                    data.latitude,
                    data.longitude,
                    typeof data.name === 'string' ? data.name : undefined,
                    typeof data.address === 'string' ? data.address : undefined,
                  );
                  deps.notifyMcpOutboundSent?.(data.chatJid);
                  logger.info(
                    {
                      chatJid: data.chatJid,
                      sourceGroup,
                      lat: data.latitude,
                      lng: data.longitude,
                    },
                    'IPC location sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC location attempt blocked',
                  );
                }
              } else if (
                data.type === 'document' &&
                data.chatJid &&
                data.filename
              ) {
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  if (
                    data.filename.includes('/') ||
                    data.filename.includes('..')
                  ) {
                    logger.warn(
                      { filename: data.filename, sourceGroup },
                      'Rejected document with unsafe filename',
                    );
                  } else {
                    const folder = targetGroup?.folder || sourceGroup;
                    const subdir =
                      data.subdir &&
                      !data.subdir.startsWith('/') &&
                      !data.subdir.includes('..')
                        ? data.subdir
                        : '';
                    const absPath = resolveMediaPath(
                      folder,
                      subdir,
                      data.filename,
                      targetGroup,
                    );
                    const bytes = fileSizeOrUndef(absPath);
                    await deps.sendDocument(
                      data.chatJid,
                      absPath,
                      data.originalName || data.filename,
                      data.caption || '',
                    );
                    deps.notifyMcpOutboundSent?.(data.chatJid);
                    recordOutboundMedia(
                      data.chatJid,
                      'document',
                      data.originalName || data.filename,
                      subdir,
                      data.caption,
                    );
                    logger.info(
                      {
                        chatJid: data.chatJid,
                        sourceGroup,
                        filename: data.filename,
                        bytes,
                      },
                      'IPC document sent',
                    );
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC document attempt blocked',
                  );
                }
              } else if (
                data.type === 'update_profile_picture' &&
                data.chatJid &&
                data.filename
              ) {
                if (
                  data.filename.includes('/') ||
                  data.filename.includes('..')
                ) {
                  logger.warn(
                    { filename: data.filename, sourceGroup },
                    'Rejected profile picture with unsafe filename',
                  );
                } else {
                  const absPath = path.join(
                    GROUPS_DIR,
                    sourceGroup,
                    data.filename,
                  );
                  await deps.updateProfilePicture(data.chatJid, absPath);
                  logger.info(
                    { sourceGroup, chatJid: data.chatJid },
                    'Profile picture updated via IPC',
                  );
                }
              } else if (
                data.type === 'update_group_name' &&
                data.chatJid &&
                data.name
              ) {
                await deps.updateGroupName(data.chatJid, data.name);
                logger.info(
                  { sourceGroup, chatJid: data.chatJid, name: data.name },
                  'Group name updated via IPC',
                );
              } else if (
                data.type === 'clear_coexistence_pause' &&
                data.chatJid
              ) {
                try {
                  await deps.releaseCoexistence(data.chatJid);
                  // Wake the worker chat: bypass the manual_mode skip on the
                  // next evaluation and enqueue it via the same queue the
                  // message loop uses. Agent reads operator↔customer history
                  // from formatMessages() XML and decides whether to follow
                  // up. No synthetic message is injected.
                  deps.forceEvaluationOnce?.(data.chatJid);
                  deps.enqueueMessageCheck?.(data.chatJid);
                  logger.info(
                    { sourceGroup, chatJid: data.chatJid },
                    'Coexistence pause release requested via IPC',
                  );
                } catch (err) {
                  logger.warn(
                    { err, sourceGroup, chatJid: data.chatJid },
                    'Coexistence pause release failed',
                  );
                }
              } else if (
                data.type === 'set_conversation_tag' &&
                data.chatJid &&
                (data.action === 'add' || data.action === 'remove') &&
                typeof data.label === 'string'
              ) {
                try {
                  await deps.setConversationTag(
                    data.chatJid,
                    data.action,
                    data.label,
                    typeof data.color === 'string' ? data.color : undefined,
                    typeof data.comment === 'string' ? data.comment : undefined,
                  );
                  logger.info(
                    {
                      sourceGroup,
                      chatJid: data.chatJid,
                      action: data.action,
                      label: data.label,
                    },
                    'Conversation tag mutation requested via IPC',
                  );
                } catch (err) {
                  logger.warn(
                    {
                      err,
                      sourceGroup,
                      chatJid: data.chatJid,
                      action: data.action,
                      label: data.label,
                    },
                    'Conversation tag mutation failed',
                  );
                }
              } else if (data.type === 'track_video_gen') {
                trackImageGeneration({
                  group_folder: sourceGroup,
                  prompt: data.prompt || '',
                  type: 'text2video',
                  model: data.model,
                  cost_usd: data.cost_usd,
                });
                logger.info(
                  { sourceGroup, gen_type: data.gen_type },
                  'Video generation tracked',
                );
              } else if (data.type === 'track_image_gen') {
                trackImageGeneration({
                  group_folder: sourceGroup,
                  prompt: data.prompt || '',
                  type: data.gen_type === 'edit' ? 'edit' : 'text2img',
                  model: data.model,
                  cost_usd: data.cost_usd,
                });
                logger.info(
                  { sourceGroup, gen_type: data.gen_type },
                  'Image generation tracked',
                );
              } else if (
                data.type === 'image' &&
                data.chatJid &&
                data.filename
              ) {
                // Sanitize filename to prevent path traversal
                if (
                  data.filename.includes('/') ||
                  data.filename.includes('..')
                ) {
                  logger.warn(
                    { filename: data.filename, sourceGroup },
                    'Rejected image with unsafe filename',
                  );
                } else {
                  const targetGroup = registeredGroups[data.chatJid];
                  if (
                    isMain ||
                    (targetGroup && targetGroup.folder === sourceGroup)
                  ) {
                    const folder = targetGroup?.folder || sourceGroup;
                    const subdir =
                      data.subdir &&
                      !data.subdir.startsWith('/') &&
                      !data.subdir.includes('..')
                        ? data.subdir
                        : '';
                    const absPath = resolveMediaPath(
                      folder,
                      subdir,
                      data.filename,
                      targetGroup,
                    );
                    const bytes = fileSizeOrUndef(absPath);
                    await deps.sendImage(
                      data.chatJid,
                      absPath,
                      data.caption || '',
                    );
                    deps.notifyMcpOutboundSent?.(data.chatJid);
                    recordOutboundMedia(
                      data.chatJid,
                      'image',
                      data.filename,
                      subdir,
                      data.caption,
                    );
                    logger.info(
                      {
                        chatJid: data.chatJid,
                        sourceGroup,
                        filename: data.filename,
                        bytes,
                      },
                      'IPC image sent',
                    );
                  } else {
                    logger.warn(
                      { chatJid: data.chatJid, sourceGroup },
                      'Unauthorized IPC image attempt blocked',
                    );
                  }
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    // Status emoji heartbeat — detect dead containers with stale emoji state
    deps.statusHeartbeat?.();

    // Periodic message recovery — catch stuck messages after retry exhaustion or pipeline stalls
    const now = Date.now();
    if (now - lastRecoveryTime >= RECOVERY_INTERVAL_MS) {
      lastRecoveryTime = now;
      deps.recoverPendingMessages?.();
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    report_to_jid?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        // Auto-set report_to_jid for cross-group tasks from main:
        // output goes back to main instead of the target group
        let reportToJid: string | null = data.report_to_jid || null;
        if (isMain && targetFolder !== sourceGroup && !reportToJid) {
          // Find main's JID
          const mainEntry = Object.entries(registeredGroups).find(
            ([, g]) => g.folder === sourceGroup,
          );
          if (mainEntry) reportToJid = mainEntry[0];
        }

        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          script: data.script || null,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          report_to_jid: reportToJid,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode, reportToJid },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          // Refuse self-pause: an agent must not cancel the task that spawned
          // it. Without this guard the model can call pause_task with its own
          // taskId mid-run, leaving the row status='paused' / last_run='' and
          // silently killing operator-initiated /trigger-reply requests.
          if (isTaskRunning(data.taskId) && task.group_folder === sourceGroup) {
            logger.warn(
              { taskId: data.taskId, sourceGroup },
              'Refused pause_task: agent tried to pause its own in-flight task',
            );
            break;
          }
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.script !== undefined) updates.script = data.script || null;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC.
        // Preserve isMain from the existing registration so IPC config
        // updates (e.g. adding additionalMounts) don't strip the flag.
        const existingGroup = registeredGroups[data.jid];
        // Shallow-merge containerConfig so partial updates (e.g. just env, or
        // just mcpServers) don't wipe previously-set fields.
        const incomingConfig =
          (data.containerConfig as Record<string, unknown> | undefined) ??
          undefined;
        const existingConfig = existingGroup?.containerConfig as
          | Record<string, unknown>
          | undefined;
        const mergedConfig =
          incomingConfig || existingConfig
            ? { ...(existingConfig || {}), ...(incomingConfig || {}) }
            : undefined;
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: mergedConfig,
          requiresTrigger: data.requiresTrigger,
          isMain: existingGroup?.isMain,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
