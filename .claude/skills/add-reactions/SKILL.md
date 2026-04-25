---
name: add-reactions
description: Add WhatsApp emoji reaction support — receive, send, store, and search reactions.
---

# Add Reactions

This skill adds emoji reaction support to NanoClaw's WhatsApp channel: receive and store reactions, send reactions from the container agent via MCP tool, and query reaction history from SQLite.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/status-tracker.ts` exists:

```bash
test -f src/status-tracker.ts && echo "Already applied" || echo "Not applied"
```

If already applied, skip to Phase 3 (Verify).

## Phase 2: Apply Code Changes

### Ensure WhatsApp fork remote

```bash
git remote -v
```

If `whatsapp` is missing, add it:

```bash
git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git
```

### Merge the skill branch

```bash
git fetch whatsapp skill/reactions
git merge whatsapp/skill/reactions || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This adds:
- `scripts/migrate-reactions.ts` (database migration for `reactions` table with composite PK and indexes)
- `src/status-tracker.ts` (forward-only emoji state machine for message lifecycle signaling, with persistence and retry)
- `src/status-tracker.test.ts` (unit tests for StatusTracker)
- `container/skills/reactions/SKILL.md` (agent-facing documentation for the `react_to_message` MCP tool)
- Reaction support in `src/db.ts`, `src/channels/whatsapp.ts`, `src/types.ts`, `src/ipc.ts`, `src/index.ts`, `src/group-queue.ts`, and `container/agent-runner/src/ipc-mcp-stdio.ts`

### Run database migration

```bash
npx tsx scripts/migrate-reactions.ts
```

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Verify

### Build and restart

```bash
npm run build
```

Linux:
```bash
systemctl --user restart nanoclaw
```

macOS:
```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Test receiving reactions

1. Send a message from your phone
2. React to it with an emoji on WhatsApp
3. Check the database:

```bash
sqlite3 store/messages.db "SELECT * FROM reactions ORDER BY timestamp DESC LIMIT 5;"
```

### Test sending reactions

Ask the agent to react to a message via the `react_to_message` MCP tool. Check your phone — the reaction should appear on the message.

## Behavior: mention-only ack reactions in trigger groups

In groups that require a trigger (`requiresTrigger !== false` and `trigger !== '.*'`), the 👀 acknowledgment fires **only on the message that individually invoked the bot** — not on every message in the processing batch. Context messages stay silent so the bot doesn't spam reactions on every comment in a group where it's one of many participants.

Main groups (`trigger: '.*'`) keep reacting to every user message.

This mirrors OpenClaw's `ackReaction.group: "mentions"` mode (see [docs.openclaw.ai/channels/whatsapp](https://docs.openclaw.ai/channels/whatsapp)).

### Why it matters

Without this filter, a single batch like `["@bot summarize", "lol", "agreed", "👍"]` produces four 👀 reactions because all four advance through the message loop together. Users perceive it as the bot "watching" every comment in the group, even when it wasn't invoked.

### Implementation pattern

`src/index.ts` derives an `isInvokingMessage(msg)` predicate **once per turn**, then uses it both for the trigger gate (`some`) and the `markReceived` loop (`filter`):

```ts
const needsTrigger = group.requiresTrigger !== false && group.trigger !== '.*';
const triggerPattern = needsTrigger ? getTriggerPattern(group.trigger) : null;
const stickerTrigger = group.containerConfig?.stickerTrigger !== false;
const allowlistCfg = loadSenderAllowlist();

const isInvokingMessage = (m): boolean => {
  if (!needsTrigger) return true; // main group: react to everything
  return (
    (triggerPattern!.test(m.content.trim()) ||
      (stickerTrigger && m.content.includes('[Sticker:'))) &&
    ((ASSISTANT_HAS_OWN_NUMBER && m.is_from_me) ||
      isTriggerAllowed(chatJid, m.sender, allowlistCfg))
  );
};

// Trigger gate: at least one invoking message present?
if (needsTrigger && !messages.some(isInvokingMessage)) return;

// Ack loop: only the invokers get 👀
for (const msg of messages) {
  if (msg.is_from_me || msg.is_bot_message) continue;
  if (!isInvokingMessage(msg)) continue;
  statusTracker.markReceived(msg.id, chatJid, false, msg.sender);
}
```

The same predicate must be applied in **both** call sites where `markReceived` fires:

- `processGroupMessages` (recovery / direct queue path)
- The main `startMessageLoop` poll cycle

If you only patch one of them, recovery messages or piped batches will leak reactions.

### What stays unchanged

- `markThinking`/`markDone`/`markFailed` use forward-only transitions, so non-tracked context messages no-op safely — no extra filtering needed downstream.
- The `is_from_me || is_bot_message` filter still excludes the bot's own messages (linked-device siblings in shared-number setups, plus bot-prefixed media).
- `stickerTrigger` and the sender allowlist participate in the predicate, so sticker-triggered turns and allowlisted senders still get their 👀.

### Reference commit

`81feb6a feat(reactions): only react to invoking message, not whole batch` — adds the predicate-based filter to both call sites in `src/index.ts`. If your skill branch was forked before this commit, apply the pattern manually using the snippet above.

## Troubleshooting

### Reactions not appearing in database

- Check NanoClaw logs for `Failed to process reaction` errors
- Verify the chat is registered
- Confirm the service is running

### Migration fails

- Ensure `store/messages.db` exists and is accessible
- If "table reactions already exists", the migration already ran — skip it

### Agent can't send reactions

- Check IPC logs for `Unauthorized IPC reaction attempt blocked` — the agent can only react in its own group's chat
- Verify WhatsApp is connected: check logs for connection status
