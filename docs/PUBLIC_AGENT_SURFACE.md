# Public Agent Surface (Formmy WABA)

Definition of the **safe surface** available to NanoClaw agents serving end users via the Formmy WABA channel (`formmy-whatsapp`). This document is the contract for any change touching `FORMMY_PUBLIC_TEMPLATE`, `KOMMO_TOOLSETS`, `EASYBITS_TOOLSETS`, or the corresponding MCP server toolset definitions.

**Last reviewed:** 2026-05-10

## Threat model

A WhatsApp end user can:

- Send arbitrary text (potentially crafted as prompt injection)
- Attach files (image, PDF, document, audio)
- Trigger the agent unlimited times subject to rate limits

The end user is **untrusted**. They may attempt to:

- Read other customers' data (CRM leads, contacts, files)
- Mutate other customers' data (move their leads, delete files)
- Exfiltrate workspace structure (schema, file list, staff roster)
- DoS the system (expensive queries, infinite loops, storage flooding)
- Run arbitrary code (shell, code execution sandboxes, web fetch)

## Defense layers

Three independent layers, all required:

| Layer | Where | What it does |
|---|---|---|
| 1. MCP server selection | `container_config.mcpServers` in `FORMMY_PUBLIC_TEMPLATE` | Whitelist of MCP servers connected to the agent. Anything not listed cannot be reached. |
| 2. Server-side toolset filtering | env vars `NANOCLAW_TOOLSETS`, `KOMMO_TOOLSETS`, `EASYBITS_TOOLSETS` | Each MCP server only registers tools whose toolset matches. Filtered at startup, before the agent sees them. |
| 3. Client-side allowlist | `container_config.allowedTools` | Exact tool names the Agent SDK is allowed to call. Specific entries (`mcp__easybits__db_select`) suppress the wildcard (`mcp__easybits__*`), blocking server-side escape hatches like `discover_tools`/`run_tool`. |

Plus per-tool guards inside individual MCPs (tenancy, SQL validation, etc.).

## The surface, by component

### Local Claude tools

```
Read, Write, Glob, Grep
```

No `Bash`, no `Edit`, no `WebSearch`, no `WebFetch`, no `NotebookEdit`, no `TodoWrite`, no `Skill`, no `ToolSearch`, no `Agent` (subagent).

### `mcp__nanoclaw__*` (NanoClaw built-in MCP)

`NANOCLAW_TOOLSETS=messaging-public,scheduling-self,quote`

| Toolset | Tools |
|---|---|
| `messaging-public` | `send_message`, `send_poll`, `send_location`, `send_reaction` |
| `scheduling-self` | `schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task` |
| `quote` | `siiqtec_quote_pdf` |

Excluded toolsets (`messaging-admin`, `groups`, `email`) cannot register new agents, broadcast to other groups, manage email integrations, etc.

### `mcp__kommo__*` (Kommo CRM)

`KOMMO_TOOLSETS=read,create,scoped-mutate`
`KOMMO_SCOPE_BY_JID=1`

| Toolset | Tools | Notes |
|---|---|---|
| `read` (public-safe subset) | `list_pipelines`, `list_tags` | Account-level structure. Safe — no per-customer data. |
| `create` | `create_lead`, `create_contact`, `add_note`, `create_task`, `add_tags_to_lead`, `add_tags_to_contact` | Auto-injects the JID scope tag on `create_lead` / `create_contact` so the lead is owned by this conversation. |
| `scoped-mutate` | `update_lead`, `remove_tags_from_lead`, `remove_tags_from_contact` | Verifies ownership before mutating. Refuses if the target lead/contact doesn't carry this conversation's scope tag. Cannot remove the scope tag itself. |

Excluded:

- `read-leads` toolset: `find_contact`, `get_contact`, `list_leads`, `get_lead`, `list_tasks` — would enable enumeration of other customers' data.
- `admin` toolset: `list_users` (staff roster), `create_pipeline`, `update_pipeline`, `create_pipeline_status` (CRM structure).

The kommo MCP server itself has **no delete tools** for any entity — even an admin agent cannot delete leads, contacts, or notes through this MCP.

#### Tenancy details

Each container gets `NANOCLAW_CHAT_JID=<jid>` injected by `container-runner.ts`. The kommo MCP computes:

```
SCOPE_TAG = "nc_" + sha256(NANOCLAW_CHAT_JID).hex[:12]
```

When `KOMMO_SCOPE_BY_JID=1`, this tag is:

- **Auto-added** on `create_lead` / `create_contact` (via `withScopeTag()` wrapper of the request body).
- **Verified** on `update_lead`, `add_note` (when `entity_type=leads`), `add_tags_to_lead`, `remove_tags_from_lead` (via `verifyLeadOwnership()` which fetches the lead, checks `_embedded.tags`, throws if missing).
- **Protected** in `remove_tags_from_lead`: the scope tag itself is silently filtered out of the removal list, so an agent cannot strip it and then claim the lead doesn't belong to anyone.

Admin groups (no `KOMMO_SCOPE_BY_JID` env) bypass these checks entirely.

### `mcp__easybits__*` (EasyBits file storage)

`EASYBITS_TOOLSETS=public-safe`

| Tool | Notes |
|---|---|
| `upload_file` | Store a user attachment. No restriction on content. Rate-limited at NanoClaw level. |
| `create_share_link` | Mint a public share URL for an uploaded file. Cannot share files the agent didn't upload (server-side ownership check by EasyBits). |
| `db_select` | Read-only SQL. SELECT or non-recursive CTE only; rejects stacked queries, comments hiding mutation, INSERT/UPDATE/DELETE/DROP/CREATE/ALTER/TRUNCATE/REPLACE/ATTACH/DETACH/PRAGMA/VACUUM/REINDEX, references to `sqlite_master`/`sqlite_schema`, `RECURSIVE`, `CROSS JOIN`, and implicit comma joins. See `easybits/app/.server/mcp/server.ts:db_select`. |

Excluded (and why):

- `db_query` — accepts arbitrary SQL including mutations and schema changes. Agent could `DELETE FROM products` via prompt injection.
- `list_files` — workspace enumeration.
- `db_list` — workspace enumeration of databases.
- `get_file` — requires explicit file ID injection per tenant; enable per-tenant when needed.
- `generate_image`, `voice_tts_create` — cost vectors. An end user can request 1000 images and burn the customer's quota. Enable per-tenant when paid use case warrants it.
- `research_search`, `research_scrape` — open internet access (Brightdata-backed). The agent gets a path to the web that the local `WebFetch`/`WebSearch` deny was supposed to close.
- All `delete_*`, `update_*`, `deploy_*`, `secret_*` — destructive or admin surface.

### Container profile

`profile: 'public'` in `container_config`. Per `container-runner.ts`:

- Omits the `/workspace/global` mount — public agent cannot read the droplet's shared knowledge base, secrets, or other groups' folders.
- Syncs from `container/skills-public/` instead of `container/skills/` (curated subset).
- Syncs from `container/agents-public/` instead of `container/agents/`.
- If either `-public/` directory doesn't exist, sync is a no-op (fail-safe).

### Rate limits (per JID)

Applied for groups with `profile: 'public'`. See `src/public-rate-limit.ts`.

| Window | Cap |
|---|---|
| 5 minutes | 12 agent spawns |
| 24 hours | 80 agent spawns |
| 24 hours | 150 000 input tokens (counting cached + cache-read) |

On block: drops the spawn, advances the cursor, notifies the user once per 5-minute cooldown. Blocked checks do not consume a slot.

## Auditing a change

Whenever this template, any of the toolsets, or any of the public-relevant MCP code changes:

1. Re-read this document end-to-end.
2. For every tool added/changed, re-justify why it's safe in the threat model above. If you can't, don't add it.
3. Confirm the build still passes: `npm run build` in nanoclaw, kommo MCP, and easybits.
4. Manual smoke test against a non-production JID before deploying to a customer-facing droplet.
5. Update **Last reviewed** at the top.

## Per-tenant escalation

A specific tenant can be granted more tools (e.g., a paid client gets `generate_image`) by overriding `container_config` on their registered group:

```sql
UPDATE registered_groups
SET container_config = json_set(container_config, '$.env.EASYBITS_TOOLSETS', 'public-safe,design')
WHERE folder = 'paid_client_x';
```

The override is per-row; the template stays untouched. Restart the service after the SQL update (memory cache).

**Do not expand the default template** to accommodate one tenant — always use the per-row override.
