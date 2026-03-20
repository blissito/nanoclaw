---
name: add-easybits
description: Add EasyBits cloud file storage MCP server so the container agent can manage files, images, webhooks, websites, and AI tasks via EasyBits.
---

# Add EasyBits Integration

This skill adds the EasyBits MCP server (`@easybits.cloud/mcp`) to the container agent. EasyBits provides 31 tools for agentic file storage, image processing, webhooks, websites, and AI.

Tools added include: `list_files`, `upload_file`, `delete_file`, `create_image`, `create_webhook`, `create_website`, and more.

## Phase 1: Pre-flight

### Check if already applied

Check if `mcp__easybits__*` exists in `container/agent-runner/src/index.ts`. If it does, skip to Phase 3 (Configure).

### Check prerequisites

No local software needed — the MCP server runs via `npx -y @easybits.cloud/mcp` inside the container. The user only needs an EasyBits API key from https://easybits.cloud.

## Phase 2: Apply Code Changes

### Ensure upstream remote

```bash
git remote -v
```

If the EasyBits skill remote is missing, add it:

```bash
git remote add easybits https://github.com/blissito/nanoclaw.git
```

### Merge the skill branch

```bash
git fetch easybits skill/easybits
git merge easybits/skill/easybits
```

This merges in:
- EasyBits MCP config in `container/agent-runner/src/index.ts` (allowedTools + mcpServers)
- `EASYBITS_API_KEY` passthrough in `src/container-runner.ts`
- `EASYBITS_API_KEY` in `.env.example`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Copy to per-group agent-runner

Existing groups have a cached copy of the agent-runner source. Copy the updated file:

```bash
for dir in data/sessions/*/agent-runner-src; do
  cp container/agent-runner/src/index.ts "$dir/"
done
```

### Validate code changes

```bash
npm run build
./container/build.sh
```

Build must be clean before proceeding.

## Phase 3: Configure

### Set EasyBits API key

Add to `.env`:

```bash
EASYBITS_API_KEY=your_api_key_here
```

Get an API key from https://easybits.cloud if you don't have one.

### Restart the service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Test via messaging

Tell the user:

> Send a message like: "list my files in easybits"
>
> The agent should use `mcp__easybits__list_files` and return results.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i easybits
```

## Troubleshooting

### Agent says it can't find EasyBits tools

1. Check `container/agent-runner/src/index.ts` has `easybits` in `mcpServers` and `mcp__easybits__*` in `allowedTools`
2. Re-copy files to per-group agent-runner (see Phase 2)
3. Rebuild container: `./container/build.sh`

### "EASYBITS_API_KEY is empty"

1. Check `.env` has `EASYBITS_API_KEY=eb_sk_...`
2. Restart the service after adding the key

### npx download is slow on first run

The first invocation downloads `@easybits.cloud/mcp` (~5s). Subsequent runs use the npm cache inside the container.
