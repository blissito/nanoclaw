---
name: add-skydropx
description: Enable the bundled Skydropx PRO MCP server for a group so its agent can quote, create, track, and cancel Mexican shipments (FedEx, DHL, Estafeta, J&T, Sendex...).
---

# Add Skydropx Integration

Enables the bundled Skydropx MCP server (`container/mcp-servers/skydropx`) for one or more groups. The MCP exposes 4 tools: `skydropx_quote`, `skydropx_create_shipment`, `skydropx_track`, `skydropx_cancel`. OAuth2 client_credentials, token cache 2h.

The server code already ships in every container image (built from the Dockerfile). This skill only handles credential injection and per-group enablement.

**⚠️ Real money.** `skydropx_create_shipment` debits the client's Skydropx wallet. The container skill at `container/skills/skydropx/SKILL.md` already instructs the agent to confirm before creating shipments — do not skip it.

## Phase 1: Pre-flight

### Confirm the target droplet

Ask the user **which droplet** to enable Skydropx on. Do not assume `ghosty-0`. Multiple production droplets exist (siiqtec-0, smatch-rulo-waba, anuar_0, ...). See memory `feedback_deploy_target.md` and `feedback_prod_naming.md`.

### Check the target uses sandbox or production

Skydropx has two endpoints:

- `https://pro.skydropx.com` — **production**, real labels, debits real wallet
- `https://sb-pro.skydropx.com` — **sandbox**, fake labels, free testing

Default in `getAllMcpServers()` is production. If the client wants sandbox, they must set `SKYDROPX_BASE_URL` explicitly.

### Check if already enabled on the droplet

SSH into the target droplet and check `.env`:

```bash
ssh root@<droplet-ip> "grep SKYDROPX /home/nanoclaw/app/.env || echo NOT_SET"
```

If `SKYDROPX_CLIENT_ID` and `SKYDROPX_CLIENT_SECRET` are already present, skip to Phase 3 (enable per group).

### Verify the MCP code is in the deployed branch

The bundled MCP server lives at `container/mcp-servers/skydropx/`. It was merged into `main` in commit `9bd1d58` (PR #4). Confirm the droplet's checked-out branch contains it:

```bash
ssh root@<droplet-ip> "ls /home/nanoclaw/app/container/mcp-servers/skydropx/dist/index.js"
```

If the file is missing, the droplet is on an older snapshot — pull `main` and rebuild the container before continuing (`git pull && ./container/build.sh`). Note: client-owned droplets (anuar_0, smatch) have **no `.git`** — see memory `project_client_droplets_no_git.md`. On those, ship a fresh snapshot or scp the directory in.

## Phase 2: Inject credentials

### Get OAuth credentials from Skydropx

The client must generate them at https://pro.skydropx.com → Settings → API → Create application. They get a `client_id` and `client_secret` (client_credentials grant).

If the client wants sandbox creds, they sign up at https://sb-pro.skydropx.com instead.

### Add to `.env` on the droplet

```bash
ssh root@<droplet-ip> "cat >> /home/nanoclaw/app/.env <<'EOF'
SKYDROPX_CLIENT_ID=<client_id>
SKYDROPX_CLIENT_SECRET=<client_secret>
EOF"
```

Add `SKYDROPX_BASE_URL=https://sb-pro.skydropx.com` only if the client is on sandbox. Production is the default in code.

### Refresh local env backup

Per memory `feedback_env_backups.md`, sync the local backup:

```bash
scp root@<droplet-ip>:/home/nanoclaw/app/.env ~/.env-backups/<droplet>.env
```

## Phase 3: Enable per group

Skydropx is opt-in per group via `container_config.mcpServers`. The agent only sees `mcp__skydropx__*` tools when enabled here.

### Find target groups

```bash
ssh root@<droplet-ip> "sqlite3 /home/nanoclaw/app/store/messages.db \
  'SELECT folder, name, container_config FROM registered_groups;'"
```

### Update `container_config`

For each group that needs Skydropx, **shallow-merge** the existing config (don't clobber `additionalMounts`, `env`, or `allowedTools`). Easiest path: read current JSON, add `skydropx` to `mcpServers`, write back.

```bash
ssh root@<droplet-ip> "sqlite3 /home/nanoclaw/app/store/messages.db \
  \"UPDATE registered_groups
     SET container_config = json_set(
       COALESCE(container_config, '{}'),
       '\$.mcpServers',
       json_insert(
         COALESCE(json_extract(container_config, '\$.mcpServers'), json('[]')),
         '\$[#]',
         'skydropx'
       )
     )
   WHERE folder = '<group-folder>';\""
```

If the group already had `skydropx` in `mcpServers`, the `json_insert` line will duplicate it — verify with the SELECT above and clean up if needed. For non-trivial JSON edits, just print the row, edit by hand, and `UPDATE ... SET container_config = '<new-json>'` directly.

### Restart the service

`registered_groups` is cached in memory at startup — config changes need a service restart, see memory `feedback_container_config_cache.md`:

```bash
ssh root@<droplet-ip> "systemctl restart nanoclaw"
```

## Phase 4: Verify

### Spawn a fresh container and ask for a quote

Tell the user:

> En el grupo objetivo, manda algo como:
>
> > cotiza un envío de cdmx a monterrey, paquete de 2kg, 30x20x10 cm
>
> El agente debería usar `mcp__skydropx__skydropx_quote` y devolver 3-5 tarifas con carrier, días y precio.

### Check container env if the agent says it can't find the tool

```bash
ssh root@<droplet-ip> "docker ps --format '{{.Names}}' | grep <group-folder>"
ssh root@<droplet-ip> "docker exec <container-name> cat /proc/1/environ | tr '\0' '\n' | grep SKYDROPX"
```

`docker inspect` hides envs loaded via `--env-file` — read `/proc/1/environ` instead, per memory `reference_container_envfile.md`.

## Troubleshooting

### Agent doesn't see `mcp__skydropx__*` tools

1. Check `mcpServers` array in `container_config` includes `"skydropx"`.
2. Confirm service was restarted after the SQL update.
3. Kill stale containers: `docker kill <name>` (the next message respawns with the new config).

### "SKYDROPX_CLIENT_ID is empty" inside container

1. Confirm `.env` has both `SKYDROPX_CLIENT_ID` and `SKYDROPX_CLIENT_SECRET`.
2. Confirm `src/container-runner.ts` `buildEnvFile()` propagates them (already does, since commit `9bd1d58`).
3. Restart the service.

### 401 from Skydropx after a few hours

Token cache is 2h. The MCP auto-refreshes — if it still 401s, the credentials were rotated or revoked on Skydropx's side. Re-issue from the dashboard and update `.env`.

### Quote returns no rates / all `success: false`

The destination postal code has no carrier coverage from any of the configured providers. Show the user only `success: true` rates (the container skill already says this). If all are `false`, suggest a different destination CP or contact Skydropx support.

### "Production vs sandbox" confusion

If the client created a "real" guía and nothing arrived, check `SKYDROPX_BASE_URL` in the container env. If it points to `sb-pro.skydropx.com`, the label was a sandbox stub — switch the env var to `https://pro.skydropx.com` (or remove it; production is the default), restart, and retry.
