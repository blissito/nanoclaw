# GhostyClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container (only for Dockerfile/dependency changes, NOT for agent-runner code)
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate channel fork, not bundled in core. Run `/add-whatsapp` (or `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git && git fetch whatsapp main && (git merge whatsapp/main || { git checkout --theirs package-lock.json && git add package-lock.json && git merge --continue; }) && npm run build`) to install it. Existing auth credentials and groups are preserved.

**WhatsApp linked device deleted / need to re-link:** Run `./scripts/wa-reconnect.sh`. It stops the service, clears auth, gets a pairing code, and restarts after linking. Enter the code in WhatsApp > Linked Devices > Link with phone number. Default phone: 527717759013. Pass a different number as argument if needed.

**The phone number passed to `wa-reconnect.sh` MUST match the WhatsApp account on the device where you'll enter the code.** WhatsApp México accepts both `521...` (legacy mobile) and `52...` (new) — they are different accounts. If WhatsApp shows "el número de teléfono no es correcto" when you enter the code, the number passed is wrong. Look at `me.id` in `store/auth/creds.json` after a known-good pair (e.g. on smatch-rulo-waba: `5215560703961`) to learn the exact format that account uses. The default `527717759013` is for the main NanoClaw number on ghosty-0; previous pair used `5217717759013` (with "1") but the active WhatsApp account no longer carries the legacy "1".

**Pairing rate limit (observed 2026-04-22).** More than ~3 pairing attempts within 30 min causes Meta to throttle the WhatsApp handshake for this device. Symptom: WA closes the socket with 405 progressively earlier (e.g. from 4.5s → 2.8s → 1.5s) after each retry, causing `requestPairingCode` to race with the close and fail `Connection Closed (428)`. Our setTimeout (3000ms) is already at the edge of that window on a fresh device; once throttled, no setTimeout value fits reliably. Only fix is to stop retrying and wait — typical backoff is 3-6 hours, possibly longer if hammered.

**Re-pair with a DIFFERENT phone number (nuke old registered_groups):** The SQLite `registered_groups` table is **account-specific** — group membership belongs to a WhatsApp account, not a JID. When you re-pair a droplet to a new number, old rows in `registered_groups` may reference groups the new account isn't even a member of. Symptoms: messages reach Baileys socket but `src/channels/whatsapp.ts` drops them before persistence because `groups[chatJid]` misses (handler only stores messages for registered groups). The chat name in `chats` may still show the old friendly name (cached from the previous pair), making it look like the group is still accessible — it isn't.

Checklist after re-pair with new number:
1. `sqlite3 /home/nanoclaw/app/store/messages.db "SELECT * FROM registered_groups;"` — audit.
2. `DELETE FROM registered_groups WHERE ...;` — purge the old entries.
3. `systemctl restart nanoclaw` — registered_groups is cached in memory at startup (see "SQL UPDATE cache" below), restart is mandatory.
4. User adds new bot to the groups they want controlled; each new group appears in `chats` with `name = jid` (unresolved) because full group-metadata sync trails behind first messages.
5. Tip to find the active admin group among several new ones: `ls store/auth/sender-key-*@g.us-*` — groups with sender-key files are the ones where bot already received distribution messages (real activity).
6. `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main) VALUES (...);` — register the new admin group with `is_main=1`, `folder='main'`.
7. Restart nanoclaw again so the cache picks up the new registration.

Without step 2, you can spend hours chasing phantom WebSocket/encryption bugs. Incident 2026-04-22 on siiqtec-0: re-paired with new dedicated number, `ghosty_siiqtec` (old main) stayed in `registered_groups`, every `@sofi` in new groups was silently dropped by the message handler filter. Only the name cache in `chats` kept showing the old "Sofi" group as resolved, masking the real issue.

## Skill Sync & Permissions

Skills are synced from `container/skills/` into each group's `.claude/skills/` at container startup (`container-runner.ts`). Since `git pull` on prod runs as root, new skill directories are owned by root. The service runs as `nanoclaw` and cannot overwrite root-owned files on subsequent syncs, causing EACCES errors that trigger retry loops.

**After any deploy that adds or modifies skills:** `chown -R nanoclaw:nanoclaw /home/nanoclaw/app/data/sessions/`

This must be part of every deploy. See the deploy checklist in memory.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.

**Agent-runner code changes REQUIRE a container rebuild.** Even though `container/agent-runner/src` is mounted into `/app/src` and the entrypoint has a "recompile if newer" check (`/app/src/index.ts -nt /app/dist/index.js`), the test fires unreliably because mounted-file mtimes often lag behind the baked `/app/dist`. Confirmed twice in production (incidents 2026-04-14 and 2026-04-20): edits landed on host, host TS rebuilt, service restarted, but containers kept exposing the old tool surface because they ran the baked `/app/dist/*.js`. Always `./container/build.sh` after touching anything under `container/agent-runner/src/`. Rebuild is also needed for Dockerfile changes (apt packages, global npm installs, entrypoint script).

## Auth Mode Switching (Production)

The credential proxy (`src/credential-proxy.ts`) reads auth from `/home/nanoclaw/app/.env` on the droplet. Switch modes without rebuild — just edit `.env` and restart:

**Switch to API-only** (when Max plan credits are exhausted):
```bash
ssh root@134.199.239.173 "sed -i 's/^CLAUDE_CODE_OAUTH_TOKEN=/#CLAUDE_CODE_OAUTH_TOKEN=/' /home/nanoclaw/app/.env && systemctl restart nanoclaw"
```

**Switch back to OAuth** (Max plan):
```bash
ssh root@134.199.239.173 "sed -i 's/^#CLAUDE_CODE_OAUTH_TOKEN=/CLAUDE_CODE_OAUTH_TOKEN=/' /home/nanoclaw/app/.env && systemctl restart nanoclaw"
```

The proxy auto-detects: if `CLAUDE_CODE_OAUTH_TOKEN` is present → OAuth (with API key fallback on 429). If absent → API key only.

**Rotate Bright Data API token:**
```bash
ssh root@$(doctl compute droplet list --format Name,PublicIPv4 --no-header | grep nanoclaw-prod | awk '{print $2}') "sed -i 's/^BRIGHTDATA_API_TOKEN=.*/BRIGHTDATA_API_TOKEN=<nuevo-token>/' /home/nanoclaw/app/.env && systemctl restart nanoclaw"
```

## Status

- OAuth (Max plan) support working in credential proxy — prefers OAuth over API key when both present
- Image vision support for WhatsApp attachments
- EasyBits MCP integration for file/image storage
- Production running on DigitalOcean droplet (systemd, `/home/nanoclaw/app`)
- Container agents detach on service restart (not killed) — must `docker kill` stale containers manually

## Trigger semantics in shared-number deployments

When the bot has a dedicated WhatsApp number (`ASSISTANT_HAS_OWN_NUMBER=true`), Baileys' `fromMe=true` reliably means "the bot wrote this" — `is_bot_message` is set to `fromMe` and bot messages are filtered out before the trigger check.

When the bot shares a WhatsApp account with humans (default, `ASSISTANT_HAS_OWN_NUMBER` unset/false — e.g. NanoClaw running on a personal phone or as a linked device on someone's number), `fromMe=true` can be ANY human linked-device sibling, not just the bot. Bot messages are detected by their `${ASSISTANT_NAME}:` prefix instead.

Crucially, the trigger check (`src/index.ts`) only honors the `is_from_me` bypass when `ASSISTANT_HAS_OWN_NUMBER=true`:
```ts
((ASSISTANT_HAS_OWN_NUMBER && m.is_from_me) || isTriggerAllowed(...))
```
Without that gate, a sibling on the same WA account would silently spawn the agent on every message they sent — observed in production on smatch-rulo-waba where a group member shared the bot's LID and was triggering containers without `@trigger`. In shared mode, every sender (including bot's account siblings) must use `@trigger` or be in the sender allowlist.

## No recurring scheduled tasks on public chats

`schedule_task` accepts `once`/`interval`/`cron`, but for `profile: 'public'` (customer-facing WABA) chats the host **degrades any `interval`/`cron` to a single `once`** run at task-creation time — in `src/ipc.ts` `processTaskIpc`, right after `nextRun` is computed and before `createTask` (the only creation path). The recurring row never gets stored; the degraded `once` fires once and `updateTaskAfterRun` marks it `completed`. Admin/internal groups keep recurring tasks.

Why: incident 2026-06-13 on sofi-0 — Sofi self-scheduled an `interval=600000ms` task to "send the pending quote"; each fire ran in isolated context (no memory of prior runs) and re-sent a fresh quote → 58 identical quotes to one customer overnight. The guard makes blind auto-repeating sends into customer chats impossible while preserving one-time follow-ups. Enforced host-side (profile comes from the DB, not the agent) → not bypassable. Deployed to all live droplets 2026-06-13. See `docs/PUBLIC_AGENT_SURFACE.md`.

## Prompt source & training reflection (verified 2026-06-23)

How a group's effective prompt is assembled, and why edits sometimes "don't reflect."

**One source of truth.** The admin/training group (`main`) reads `groups/main/CLAUDE.md` directly. Public WABA groups (`profile: 'public'`) read the **same** file via a read-only **training overlay**: `src/container-runner.ts` mounts every file in the training folder (`FORMMY_TRAINING_GROUP_FOLDER`, = `main`) onto `/workspace/group/<file>` ro, shadowing the per-customer folder. So `main/CLAUDE.md` (plus catalog, product images, reference docs) is what every WABA agent actually reads — the per-customer `groups/formmy_*/CLAUDE.md` is usually 0 bytes and is **not** what the agent sees. Train in `main` → applies to all WABA.

**When CLAUDE.md is read.** The SDK reads CLAUDE.md (claude_code preset, `cwd: /workspace/group`) **once when the container / `query()` starts**, and fixes it for that container's lifetime. The resume transcript (`data/sessions/<folder>/.claude/projects/-workspace-group/<uuid>.jsonl`) stores **only** user/assistant messages — **no system prompt** (verified: entry types are `user` / `assistant` / `queue-operation`; no `system`, no `claude_code`). So on `--resume` the SDK **rebuilds the system prompt from the current CLAUDE.md** — resume does NOT pin an old prompt. (This is also why the host injects the date per-message via a `UserPromptSubmit` hook: the base prompt is built per-container, not per-message.)

**Why "I edited the prompt and nothing changed":** a **live/warm** container keeps the prompt it read at startup. The edit reflects only on the **next container spawn**, which re-reads the current file — even when resuming the same session. Containers die on idle, so an edit applies on the next message *after* the warm container exits.

**Force a reflect now** (without waiting for idle): `docker kill` the group's running container → the next message respawns it, re-reads the prompt, and **resumes the same session (no lost context)**. Prefer this over `DELETE FROM sessions WHERE group_folder=?` (which also works but starts a fresh session and loses conversational continuity). Check if a group is warm with `docker ps | grep <folder>`.

**Pipeline edit rights (admin yes / WABA no) are code-gated, not just prompt-gated.** `main` loads `kommo` with no `KOMMO_TOOLSETS` → all toolsets incl. pipeline structure CRUD (`create_pipeline` / `update_pipeline` / `create_pipeline_status`, in the `admin` toolset). Public WABA groups set `KOMMO_TOOLSETS=read,create,scoped-mutate` → those tools are never registered, so a WABA agent **cannot** restructure the pipeline regardless of prompt (it can still create/move/read leads — `update_lead` takes `status_id`/`pipeline_id`). ⚠️ Default when `KOMMO_TOOLSETS` is unset = ALL toolsets (`ENABLED_TOOLSETS = … : null // null = all`, `container/mcp-servers/kommo/src/index.ts`) — fail-OPEN, so every public group must set the restricted toolset explicitly.

## Adding MCP Servers

Per-group MCP servers give agents domain-specific tools. Each group's `container_config.mcpServers` array controls which servers are available (the `nanoclaw` server is always included automatically).

### Steps to add a new MCP server

**1. Define in agent-runner** — `container/agent-runner/src/index.ts` → `getAllMcpServers()`
```ts
'my-mcp': {
  command: 'npx',
  args: ['-y', 'my-mcp-package'],
  env: {
    MY_SECRET: process.env.MY_SECRET || '',
  },
},
```

**2. Pre-install in Dockerfile** — `container/Dockerfile` → `npm install -g` line
```
RUN npm install -g ... my-mcp-package
```
This avoids `npx -y` downloading on every container start.

**3. Inject secrets** (skip if reusing existing env vars) — `src/container-runner.ts` → `buildEnvFile()`
```ts
const mySecret = readEnvFile(['MY_SECRET']).MY_SECRET;
if (mySecret) envLines.push(`MY_SECRET=${mySecret}`);
```
Then add `MY_SECRET=xxx` to `.env` on prod (`/home/nanoclaw/app/.env`).

**4. Enable per group** — update `container_config` in SQLite
```sql
-- Check current config
SELECT name, container_config FROM registered_groups WHERE folder = 'whatsapp_my-group';
-- Update (replace full JSON, preserving other fields like additionalMounts)
UPDATE registered_groups SET container_config = '{"mcpServers":["easybits","my-mcp"]}' WHERE folder = 'whatsapp_my-group';
```
Prod DB path: `/home/nanoclaw/app/store/messages.db`

**5. Deploy**
```bash
git push
# Agent-runner changes only (no Dockerfile change): just git pull + restart
ssh root@<ip> 'cd /home/nanoclaw/app && git pull && systemctl restart nanoclaw'
# Dockerfile changes (new npm install -g): rebuild container
ssh root@<ip> 'cd /home/nanoclaw/app && git pull && ./container/build.sh'
```

### Per-group env overrides

Add `"env": {"KEY": "value"}` to `container_config` to override `.env` values for a specific group. Overrides apply only to containers spawned for that group; the global `.env` file is never touched. Two ways to set:

**From chat (preferred when bot is healthy):** the main group's admin agent calls the `register_group` MCP tool with the group's existing `jid`/`name`/`folder`/`trigger` plus `env={KEY: "value"}`. The host shallow-merges the incoming `containerConfig` over whatever was previously stored — pass `mcp_servers` to update only servers, pass `env` to update only env, pass both to update both. Omitted fields are preserved (e.g. you don't lose `additionalMounts` when adding `env`).

**Direct SQL (fastest from SSH):**
```sql
UPDATE registered_groups SET container_config = '{"mcpServers":["smatch-public"],"env":{"SMATCH_CLUB_ID":"abc123"}}' WHERE folder = 'my_group';
```

Common patterns:
- **Multi-tenant isolation**: `env={"SMATCH_CLUB_ID":"<club-id>"}` on a demo group locks `smatch-mcp` to one club (no cross-tenant leakage). Without this override, `SMATCH_CLUB_ID` is empty and the MCP enters super-admin / multi-club mode.
- **Per-group prod vs staging DB**: `env={"SMATCH_MONGODB_URI":"<prod-uri>"}` on the admin group keeps it on prod data while public-facing demo groups stay on staging.

**⚠️ SMATCH_MONGODB_URI must include the DB name.** `smatch-mcp` calls `mongoose.connect(uri)`. If the URI ends in `/` without a database name (e.g. `mongodb+srv://user:pass@smatch-prod-cluster0.inq1top.mongodb.net/`), mongoose silently connects to the default `test` DB — which in the smatch-prod cluster exists with the same collection names (`clubs`, `tournaments`, `courts`, ...) but empty. Symptom: agent reports "DB vacía, cero clubs" even though credentials and cluster are correct, and the `SMATCH_CLUB_ID` object is not found. Always terminate the URI with the real DB name: `.../smatch-prod`. Verify inside a running container with `docker exec <name> env | grep SMATCH_MONGODB_URI`. Incident 2026-04-20 (`whatsapp_m2m-x-smatch` on smatch-rulo-waba, client Magnolia).

### Currently registered MCP servers

| Name | Package | Env Vars | Purpose |
|------|---------|----------|---------|
| `nanoclaw` | built-in | (auto) | Core tools: group mgmt, IPC, email |
| `easybits` | `@easybits.cloud/mcp` | `EASYBITS_API_KEY` | File/image/document storage |
| `easybits-design-core-sandbox` | `@easybits.cloud/mcp --tools design,core,sandbox` | `EASYBITS_API_KEY` | Design + Core + Firecracker microVM sandbox toolset (KS-5): `sandbox_create/list/status/destroy/exec/run_code/files_*` + `agent_run` (Claude managed). Para harness de agentes y código aislado. |
| `kommo` | bundled (`container/mcp-servers/kommo`) | `KOMMO_BASE_URL`, `KOMMO_ACCESS_TOKEN` | Kommo CRM (leads, contacts, pipelines read/write) |
| `smatch` | `smatch-mcp` | `SMATCH_MONGODB_URI`, `SMATCH_CLUB_ID` (optional → admin/multi-club mode) | Club admin (full CRUD). Empty `SMATCH_CLUB_ID` enables `list_clubs` and per-call `clubId` parameter. |
| `smatch-public` | `smatch-mcp-public` | `SMATCH_MONGODB_URI`, `SMATCH_CLUB_ID` | Public read-only + reservation requests. Same admin/club-mode behavior as `smatch`. |
| `brightdata` | `@brightdata/mcp` | `BRIGHTDATA_API_TOKEN` | Web scraping/search |
| `skydropx` | bundled (`container/mcp-servers/skydropx`) | `SKYDROPX_CLIENT_ID`, `SKYDROPX_CLIENT_SECRET`, `SKYDROPX_BASE_URL` (opt, default prod) | Envíos México: cotizar/crear/rastrear/cancelar guías. OAuth2 client_credentials, token cache 2h. Quote endpoint async — el tool poll-ea internamente hasta `is_completed`. |

## Client Snapshot (Deploy to New Droplet)

Creates a sanitized snapshot safe for client deployment. Fully automated via `doctl`:

```bash
./scripts/prepare-snapshot.sh [snapshot-name]
# Default name: nanoclaw-client-YYYY-MM-DD
```

Flow: snapshot prod → create temp clone → SSH in and sanitize → snapshot clone → destroy clone + temp snapshot.

Removes: `.env` values, WhatsApp auth, SQLite DB, container sessions, groups, SSH keys, shell history, systemd journal, Docker images. See `scripts/prepare-snapshot.sh` for details.

Prerequisites: `doctl auth init` and SSH access to prod.

After deploying the clean snapshot, the client fills `.env` from `.env.template`, runs `./container/build.sh`, and starts the service.

### Clean install (when the snapshot disk exceeds the target plan)

A snapshot inherits the source droplet's **allocated disk** as its restore floor — not its used data. A droplet that was resized up (e.g. `sofi-0` grew to a 160GB disk on `s-4vcpu-8gb`) yields a snapshot that can only restore to plans with ≥ that disk (cheapest ~$48/mo). To stand up a low-cost sister instance ($12 / `s-1vcpu-2gb` / 50GB), do a **clean install** instead of cloning:

1. Create a plain Ubuntu 24.04 droplet on the target plan.
2. `apt` install Node 22 (NodeSource) + Docker (get.docker.com) + `sqlite3 build-essential python3 rsync psmisc`.
3. Create the `nanoclaw` user (add to the `docker` group); `rsync` the repo (exclude `.git node_modules store data logs .env groups`). **Then copy the shared base back in: `groups/global/CLAUDE.md` (Ghosty strategy: file-handling discipline, big-file rules, reasoning) and `groups/main/CLAUDE.md`.** The blanket `groups` exclude keeps client conversation data from leaking between droplets, but it also drops these two tracked files — without `groups/global/CLAUDE.md` the agent loses the large-file strategy and is more prone to context thrash (incident 2026-06-11, caribeños).
4. `npm ci && npm run build`, then `./container/build.sh`.
   **Every group you register must get a scoped `container_config.mcpServers`** (e.g. `["nanoclaw","easybits","brightdata"]`). Code defaults empty config to that lean set, but be explicit — loading every MCP server bloats the static prompt past the ~200k window and thrashes.
5. Replicate from a known-good droplet: the systemd unit (`/etc/systemd/system/nanoclaw.service`), `~/.config/nanoclaw/mount-allowlist.json`, and `.env` (copy shared keys; override per-instance `ASSISTANT_NAME` / `WHATSAPP_PHONE_NUMBER` / `MAX_CONCURRENT_CONTAINERS`).
6. Pair WhatsApp (pairing-code flow). **Confirm the link by polling `store/auth/creds.json` for a populated `account`/`platform` — NOT `registered`, which Baileys sets optimistically when it *generates* the code (false positive).** Then register the main group and restart.

`tania` (team Sofi, sister of `sofi-0`) was built this way on 2026-05-22.

## Parallel Sub-agents (Agent tool)

**Status: disabled.** Not supported on current droplet sizes until we test on bigger instances. The `Agent` tool is removed from the default `buildAllowedTools()` list in `container/agent-runner/src/index.ts`.

Why disabled: observed in production (smatch-rulo-waba, 2026-04-20) that Rulo delegated a Smatch tournament query to `Agent` → sub-agent does NOT inherit parent MCP servers → sub-agent fell back to writing a raw mongoose script in `/tmp` and ran it via Bash. Took 3+ minutes, no progress feedback to the user, and bypassed the MCP's safety layer. General pattern: sub-agents spawned from Agent tool lose MCP context, so any task that needs MCP tools should stay on the main agent.

Technical notes for re-enablement (future, bigger droplets):
- Sub-agents spawn as `claude` CLI processes (installed globally in the image). Each uses ~100-150MB RAM, so 2GB is tight for 2-3 parallel agents.
- Current value: none for web research (sequential `WebSearch` is fast enough) or for DB queries (can't access MCP anyway).
- When re-enabling, also (a) propagate MCP servers to sub-agents OR document the loss clearly, and (b) add a progress message instruction to `groups/global/CLAUDE.md` so users get feedback while sub-agents work.

Per-group override still works: groups can set `allowedTools` in `container_config` to include `Agent` and opt back in selectively.

## Rate Limit Fallback

When OAuth (Max plan) gets rate-limited (429), the credential proxy retries with API key + `claude-sonnet-5` (`FALLBACK_MODEL` in `src/credential-proxy.ts`). The fallback model must be Agent SDK-compatible (accepts the SDK's `thinking: { type: "adaptive" }`). Haiku doesn't work.

**Primary model is also pinned to `claude-sonnet-5`.** `src/container-runner.ts` injects `ANTHROPIC_MODEL` into the container env so the agent runs Sonnet 5 over the Max plan (instead of Claude Code's default). Override per-droplet with `NANOCLAW_MODEL` in `.env`. So primary and 429-fallback are both Sonnet 5.

**⚠️ Model ID format — DO NOT guess model IDs.** Aliases do NOT take a date suffix. Correct: `claude-sonnet-5`, `claude-opus-4-8`. Wrong: `claude-sonnet-5-20250514`, `claude-sonnet-4-6-20250514`. Older dated snapshots (e.g. `claude-sonnet-4-20250514`) keep their date. If you need to change a model, verify the ID first:
```bash
curl -s https://api.anthropic.com/v1/messages \
  -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d '{"model":"MODEL_ID","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}' | python3 -m json.tool
```

**Testing the fallback** (run from repo root):
```bash
# Spins up a fake upstream that returns 429 on first call, then forwards retry to real API.
# Verifies: OAuth gets 429 → retry with API key + FALLBACK_MODEL → 200 OK.
node -e "
const http=require('http'),https=require('https');let n=0;
const fake=http.createServer((req,res)=>{const c=[];req.on('data',d=>c.push(d));req.on('end',()=>{n++;
const body=JSON.parse(Buffer.concat(c).toString()),auth=req.headers['x-api-key']?'API-KEY':'OAUTH';
console.log('#'+n+' model='+body.model+' auth='+auth);
if(n===1){res.writeHead(429,{'content-type':'application/json'});res.end('{\"type\":\"error\"}');return;}
const rb=Buffer.from(JSON.stringify(body)),h={...req.headers,host:'api.anthropic.com','content-length':rb.length};
delete h.connection;delete h['keep-alive'];
const r=https.request({hostname:'api.anthropic.com',port:443,path:req.url,method:'POST',headers:h},rr=>{
const rc=[];rr.on('data',d=>rc.push(d));rr.on('end',()=>{const t=Buffer.concat(rc).toString();
try{const p=JSON.parse(t);console.log(p.content?'✅ '+p.content[0].text:'❌ '+JSON.stringify(p.error));}catch{}
res.writeHead(rr.statusCode,rr.headers);res.end(t);});});r.write(rb);r.end();});});
fake.listen(18430,'127.0.0.1',()=>{const fs=require('fs'),key=fs.readFileSync('.env','utf8').match(/ANTHROPIC_API_KEY=(.*)/)[1],
FM='claude-sonnet-5',bh={'content-type':'application/json','anthropic-version':'2023-06-01'},
b1=JSON.stringify({model:'claude-opus-4-20250514',max_tokens:30,messages:[{role:'user',content:'Reply: fallback-ok'}]});
http.request({hostname:'127.0.0.1',port:18430,path:'/v1/messages',method:'POST',
headers:{...bh,authorization:'Bearer fake',  'content-length':Buffer.byteLength(b1)}},r1=>{const c1=[];r1.on('data',d=>c1.push(d));
r1.on('end',()=>{if(r1.statusCode!==429){console.log('ERROR: expected 429');process.exit(1);}
const b2=JSON.stringify({model:FM,max_tokens:30,messages:[{role:'user',content:'Reply: fallback-ok'}]});
http.request({hostname:'127.0.0.1',port:18430,path:'/v1/messages',method:'POST',
headers:{...bh,'x-api-key':key,'content-length':Buffer.byteLength(b2)}},r2=>{const c2=[];r2.on('data',d=>c2.push(d));
r2.on('end',()=>{fake.close();process.exit(r2.statusCode===200?0:1);});}).end(b2);});}).end(b1);});
"
```

**Error protection:**
- Model/auth errors (`not_found_error`, `authentication_error`, etc.) are fatal — no retry, cursor advances
- After 2 failed retries, group enters 5-minute cooldown (new messages ignored)
- Error messages to channels suppressed if sent <5 min ago for same group

Config: `FALLBACK_MODEL` in `src/credential-proxy.ts`. Fatal patterns in `src/index.ts` (`fatalContainerPatterns`). Cooldown in `src/group-queue.ts`.

## WhatsApp inbound audio & media forwards (fixed 2026-07-02)

**The bug (Baileys / `src/channels/whatsapp.ts`):** a forwarded/shared audio **file** arrives as a bare `audioMessage` with `ptt` false/undefined. `isVoiceMessage()` matches **only** `audioMessage.ptt === true` (push-to-talk notes), and the `documentMessage` branch never fires for a native `audioMessage`. So `content` stayed `''` and the message was dropped at `if (!content) continue;` — **no log, no attachment, no failsafe**. Symptom: agent keeps replying "no veo ningún audio" to a forwarded audio (incident: DESCTI_Innovación, 50-min forward). It is **not** RAM/OOM — the media never reached the pipeline.

**The fix (commit `c28e50b`, host code — `npm run build` + restart, no image rebuild):**
- New branch after the voice branch: `if (normalized?.audioMessage && !isVoiceMessage(msg))` → download + save to `attachments/audio-<ts>.<ext>`, surface `[Audio file: …]` + a hint (`audio-largo` to transcribe speech, `audio-analyze` to describe music). Does **not** transcribe inline (non-ptt audio may be music or 50+ min → would block the socket). Failsafe mirrors the voice path.
- **Catch-all anti-drop** just before `if (!content) continue;`: any unhandled non-text type persists `[Adjunto no soportado: <tipo>]` instead of vanishing. So nothing is ever dropped silently again.
- **Skill `audio-largo`** (`container/skills/audio-largo/`): transcribes long/large speech by splitting with ffmpeg into 10-min mono segments and running each through OpenAI Whisper (dodges the API's 25MB cap). Container has ffmpeg but **not** whisper-cli, so it uses the API; `OPENAI_API_KEY` is already injected (`container-runner.ts:373`). Syncs at container spawn — no rebuild.

**WABA (Formmy) channels are NOT affected — verified.** The WABA path (`src/channels/formmy-whatsapp.ts` `processMedia`) never had this bug: Meta Cloud API delivers media **pre-classified by `type`** (`image`/`audio`/`document`/`sticker`) with no ptt-vs-file distinction, so a forwarded audio arrives as `type:'audio'` and is saved + transcribed like any audio. Every branch saves + returns a hint; the `default` case and the catch return `[Media: <type> …]` placeholders, and `if (!jid || (!content && !media))` 400s with a diagnostic `warn` — **nothing is silently dropped on our side**. Two caveats: (1) it depends on the Formmy bridge actually forwarding the media payload (if Formmy ships `content:"[Unsupported…]"` for a type it can't parse, that's upstream — logged by the `non-standard payload` diagnostic at `formmy-whatsapp.ts:445`); (2) `InboundMedia.type` has no `video` — a forwarded **video** hits the `default` case → `[Media: video]` placeholder (surfaced, buffer not saved). Not a silent drop, but the only soft spot in the WABA media path.

## Voice / TTS (Kokoro local)

The `voice` skill (`container/skills/voice/text-to-speech`) does TTS with **Kokoro running locally** (`kokoro-onnx`, free, no API key) and **OpenAI `onyx` as fallback**. ElevenLabs was the old primary but its credits are exhausted; the script no longer calls it (the `clone-voice` flow was ElevenLabs-only and is currently unavailable).

- **Model baked into the image** (`container/Dockerfile`, full builds only / `LEAN=0`): `kokoro-onnx` + `soundfile` + `espeak-ng` (Spanish phonemizer); `/opt/kokoro/kokoro-v1.0.onnx` (~325MB) + `voices-v1.0.bin` from the `thewh1teagle/kokoro-onnx` release `model-files-v1.0`. Env `KOKORO_MODEL` / `KOKORO_VOICES`. No runtime HuggingFace download. Image grows ~1.5GB (~5.4GB → ~6.9GB).
- **Spanish voices** (Kokoro only ships these): `santa`=`em_santa` (default), `alex`=`em_alex` (M), `dora`=`ef_dora` (F). Legacy ElevenLabs names (antonio/jc/brian/daniel/enrique/maya/cristina/regina) **remap** to the closest Kokoro voice so old skills/tasks keep working. `lang='es'`; output WAV 24kHz → ffmpeg → Ogg Opus mono 48kHz.
- **Perf — bound the threads.** The skill sets `OMP_NUM_THREADS` (default 4, tune with `KOKORO_THREADS`). Leaving it unset lets onnxruntime oversubscribe on small CPUs and thrash: inference measured ~9s vs ~3.5s when bounded (RTF 0.58). Full text-to-speech end-to-end ≈6s on a 4-vCPU droplet (~0.85s import + ~2–3s model load, fixed per call since each invocation is a fresh process, + ~3.5s inference). The **int8 quantized model was tested and rejected** — slower on CPUs without AVX-VNNI.
- **Kokoro is not the bottleneck for perceived latency.** A voice-note turn can take minutes; that's the agent (LLM turns, cold start, shared rate limit), not the ~6s TTS. To reduce perceived latency, cut agent steps (prompt it to send only the audio) or keep the container warm.
- **Skill changes don't need a rebuild** (skills sync at container spawn); only Dockerfile changes (model/pip/apt) require `./container/build.sh`. To apply to a warm container now, `docker kill` it → next message respawns with the new skill and resumes the same session.

## Agent Vault (WIP)

Inspired by [OneCLI](https://github.com/onecli/onecli). Implemented in `src/credential-proxy.ts`:

- **Per-group policies** — `setGroupPolicy(folder, { maxRequestsPerWindow, allowedModels, maxInputTokens, blocked })`
- **Rate limiting** — sliding window counter, enforced before forwarding
- **Usage logging** — ring buffer (500 entries) with tokens/model/duration/fallback flag
- **Endpoints**:
  - `GET /nanoclaw/vault/usage?group=X` — query usage
  - `POST /nanoclaw/vault/policy` — set policy `{ groupFolder, policy }`

**Open TODO**: group identification. Currently logs as `unknown` unless `X-NanoClaw-Group` header is set. SDK traffic doesn't set headers — needs a scalable mapping (container IP → folder, or other). Do NOT encode in `ANTHROPIC_BASE_URL` per container — dozens of groups daily make it brittle.

Roadmap for EasyBits generalization: `/Users/bliss/easybits/TODO_AGENT_VAULT.md`.

## Next Steps

### Active

- **MCP toolsets dinámicos** — named subsets of tools per MCP server, activated per group. Motivated by servers like EasyBits with 100+ tools: today we load a fixed `core` for every group; we want `"ghosty, ponle al grupo demoX el toolset de easybits para marketing"`. Adopts GitHub MCP's vocabulary (`default | all | <lista>`; `dynamic` queda para fase 2). Design:
  - **Catálogo.** Servers propios (`easybits`, `nanoclaw`, `kommo`) aceptan env var `<SERVER>_TOOLSETS=core,marketing` y filtran al registrar tools (mismo patrón que `GITHUB_TOOLSETS`). Para servers ajenos, archivo versionado `container/toolsets.json` mapea `{ server: { toolset: [tool_names] } }` y se filtra client-side vía `allowedTools` del Agent SDK.
  - **Storage por grupo.** Nuevo campo en `container_config` (SQLite): `{"mcpServers":["easybits"],"toolsets":{"easybits":["core","marketing"]}}`. Default implícito: `["core"]` si falta.
  - **Runtime.** `src/container-runner.ts` al spawn: inyecta `<SERVER>_TOOLSETS` env var para servers propios; expande + agrega a `allowedTools` para servers ajenos. Sin hot-reload — aplica al próximo container spawn.
  - **Interfaz Ghosty main.** Dos tools nuevos en el MCP `nanoclaw`: `set_group_toolsets(group, server, toolsets[], action: add|remove|replace)` y `list_toolsets(server?)` para descubrimiento. El parseo NL lo hace el LLM.
  - **Orden de implementación.** (1) schema SQLite + expansión en container-runner; (2) toolsets nativos en `easybits` (empezar con `core`/`marketing`/`files`); (3) tools `set_group_toolsets` y `list_toolsets` en `nanoclaw` MCP; (4) docs de toolsets disponibles por server.
  - **Fase 2 (dynamic discovery).** Cuando easybits tenga 100+ tools reales, añadir keyword `dynamic` + meta-tool `easybits_enable(category)` estilo Salesforce/GitHub. Ahorra tokens de context pero agrega round-trip.
  - **Refs.** GitHub toolsets pattern: https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/configure-toolsets ; Dynamic discovery RFC: https://github.com/github/github-mcp-server/issues/275

### Dismissed soon — to archive (2026-05-18)

Marcado para no trabajarse; revisar y eliminar de aquí en la siguiente limpieza.

- ~~**Meta WABA direct channel**~~ — webhook directo a Meta Cloud API eliminando Formmy proxy. Env vars `META_WABA_*`, ~200-300 lines patrón telegram.ts. Dismissed.
- ~~**1-to-1 WhatsApp support**~~ — privados como grupos individuales para B2C (clinics, real estate, restaurants). Dismissed.
- ~~**WhatsApp-only CRM**~~ — memoria persistente + history + dashboards on-demand vía EasyBits. Dismissed.
- ~~**Rate limit handling**~~ — queue/retry para Max plan, `MAX_CONCURRENT_CONTAINERS=2`, API key fallback. Dismissed.
- ~~**Dashboard on demand**~~ — agente genera HTML dashboards por cliente, sube a EasyBits, manda link. Dismissed.
- ~~**Director/control channel**~~ — 1:1 privado del owner con `/tell <group> <instruction>` inyectando `<director>` en sesión activa. Dismissed.
