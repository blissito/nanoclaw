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

## Skill Sync & Permissions

Skills are synced from `container/skills/` into each group's `.claude/skills/` at container startup (`container-runner.ts`). Since `git pull` on prod runs as root, new skill directories are owned by root. The service runs as `nanoclaw` and cannot overwrite root-owned files on subsequent syncs, causing EACCES errors that trigger retry loops.

**After any deploy that adds or modifies skills:** `chown -R nanoclaw:nanoclaw /home/nanoclaw/app/data/sessions/`

This must be part of every deploy. See the deploy checklist in memory.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.

**Agent-runner code changes do NOT require container rebuild.** The entrypoint auto-recompiles TypeScript when the mounted source (`/app/src`) is newer than the compiled output (`/app/dist`). Just `git pull` on prod and restart the service. Rebuild is only needed for Dockerfile changes (apt packages, global npm installs, entrypoint script).

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

Add `"env": {"KEY": "value"}` to `container_config` to override `.env` values for a specific group:
```sql
UPDATE registered_groups SET container_config = '{"mcpServers":["smatch-public"],"env":{"SMATCH_CLUB_ID":"abc123"}}' WHERE folder = 'my_group';
```
Overrides replace the global `.env` value for that container only. Other groups are unaffected.

### Currently registered MCP servers

| Name | Package | Env Vars | Purpose |
|------|---------|----------|---------|
| `nanoclaw` | built-in | (auto) | Core tools: group mgmt, IPC, email |
| `easybits` | `@easybits.cloud/mcp` | `EASYBITS_API_KEY` | File/image/document storage |
| `panel` | `panel-mcp` | `PANEL_API_KEY`, `PANEL_URL` | Server panel management |
| `smatch` | `smatch-mcp` | `SMATCH_MONGODB_URI`, `SMATCH_CLUB_ID` | Club admin (full CRUD) |
| `smatch-public` | `smatch-mcp-public` | `SMATCH_MONGODB_URI`, `SMATCH_CLUB_ID` | Public read-only + reservation requests |
| `brightdata` | `@brightdata/mcp` | `BRIGHTDATA_API_TOKEN` | Web scraping/search |

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

## Parallel Sub-agents (Agent tool)

Tested and working: adding `'Agent'` to `buildAllowedTools()` in `container/agent-runner/src/index.ts` enables Claude Code's Agent tool inside containers. Sub-agents spawn as `claude` CLI processes (already installed globally in the image). Each sub-agent uses ~100-150MB RAM, so the 2GB droplet is tight for 2-3 parallel agents. Currently **disabled** — re-enable when there's a compelling use case (e.g., parallel codebase exploration). For web research tasks, sequential `WebSearch` is fast enough. When re-enabling, also add a progress message instruction to `groups/global/CLAUDE.md` so users get feedback while sub-agents work.

## Rate Limit Fallback

When OAuth (Max plan) gets rate-limited (429), the credential proxy retries with API key + `claude-sonnet-4-20250514`. The fallback model must be Agent SDK-compatible (supports reasoning). Haiku doesn't work.

**⚠️ Model ID format — DO NOT guess model IDs.** Anthropic model IDs do NOT include the minor version number. Correct: `claude-sonnet-4-20250514`. Wrong: `claude-sonnet-4-6-20250514`, `claude-sonnet-4-5-20241022`. If you need to change the fallback model, verify the ID first:
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
FM='claude-sonnet-4-20250514',bh={'content-type':'application/json','anthropic-version':'2023-06-01'},
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

- **Meta WABA direct channel** — new `src/channels/meta-waba.ts` that receives webhooks from Meta Cloud API directly, eliminating the Formmy message proxy. Formmy stays as the solution provider (token/number management via Meta Business Manager), but messages flow `WhatsApp → Meta → NanoClaw → Meta → WhatsApp` with no intermediary. This removes Formmy as a SPOF for message routing. Env vars: `META_WABA_VERIFY_TOKEN`, `META_WABA_APP_SECRET`, `META_WABA_ACCESS_TOKEN`, `META_WABA_PHONE_NUMBER_ID`. Same channel pattern as telegram.ts/webhook.ts (~200-300 lines). Covers: webhook verification (Meta challenge), signature validation, inbound message parsing (text, image, audio, location), outbound via Graph API.
- **1-to-1 WhatsApp support** — route private messages as individual "groups" with their own memory, enabling B2C use cases (clinics, real estate, restaurants)
- **WhatsApp-only CRM** — persistent client memory + conversation history + on-demand dashboards generated by the agent and published via EasyBits
- **Rate limit handling** — queue/retry for Max plan rate limits instead of failing. Consider `MAX_CONCURRENT_CONTAINERS=2` in .env to reduce concurrent API calls, or API key fallback. Discuss with user before changing — current default is 5.
- **Dashboard on demand** — agent generates custom HTML dashboards per client, uploads to EasyBits, sends link via WhatsApp
- **Director/control channel** — private 1-to-1 chat where the owner can guide the agent in real time (`/tell <group> <instruction>`). Injects `<director>` system messages into the active container session. ~50-80 lines, no core pattern changes needed.
