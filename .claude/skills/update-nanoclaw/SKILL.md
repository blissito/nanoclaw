---
name: update-nanoclaw
description: Efficiently bring upstream NanoClaw updates into a customized install, with preview, selective cherry-pick, and low token usage.
---

# About

Your NanoClaw fork drifts from upstream as you customize it. This skill pulls upstream changes into your install without losing your modifications.

Run `/update-nanoclaw` in Claude Code.

## How it works

**Preflight**: checks for clean working tree (`git status --porcelain`). If `upstream` remote is missing, asks you for the URL (defaults to `https://github.com/qwibitai/nanoclaw.git`) and adds it. Detects the upstream branch name (`main` or `master`).

**Backup**: creates a timestamped backup branch and tag (`backup/pre-update-<hash>-<timestamp>`, `pre-update-<hash>-<timestamp>`) before touching anything. Safe to run multiple times.

**Preview**: runs `git log` and `git diff` against the merge base to show upstream changes since your last sync. Groups changed files into categories:
- **Skills** (`.claude/skills/`): unlikely to conflict unless you edited an upstream skill
- **Source** (`src/`): may conflict if you modified the same files
- **Build/config** (`package.json`, `tsconfig*.json`, `container/`): review needed

**Update paths** (you pick one):
- `merge` (default): `git merge upstream/<branch>`. Resolves all conflicts in one pass.
- `cherry-pick`: `git cherry-pick <hashes>`. Pull in only the commits you want.
- `rebase`: `git rebase upstream/<branch>`. Linear history, but conflicts resolve per-commit.
- `abort`: just view the changelog, change nothing.

**Conflict preview**: before merging, runs a dry-run (`git merge --no-commit --no-ff`) to show which files would conflict. You can still abort at this point.

**Conflict resolution**: opens only conflicted files, resolves the conflict markers, keeps your local customizations intact.

**Validation**: runs `npm run build` and `npm test`.

**Breaking changes check**: after validation, reads CHANGELOG.md for any `[BREAKING]` entries introduced by the update. If found, shows each breaking change and offers to run the recommended skill to migrate.

## Rollback

The backup tag is printed at the end of each run:
```
git reset --hard pre-update-<hash>-<timestamp>
```

Backup branch `backup/pre-update-<hash>-<timestamp>` also exists.

## Token usage

Only opens files with actual conflicts. Uses `git log`, `git diff`, and `git status` for everything else. Does not scan or refactor unrelated code.

---

# Goal
Help a user with a customized NanoClaw install safely incorporate upstream changes without a fresh reinstall and without blowing tokens.

# Operating principles
- Never proceed with a dirty working tree.
- Always create a rollback point (backup branch + tag) before touching anything.
- Prefer git-native operations (fetch, merge, cherry-pick). Do not manually rewrite files except conflict markers.
- Default to MERGE (one-pass conflict resolution). Offer REBASE as an explicit option.
- Keep token usage low: rely on `git status`, `git log`, `git diff`, and open only conflicted files.

# Step 0: Preflight (stop early if unsafe)
Run:
- `git status --porcelain`
If output is non-empty:
- Tell the user to commit or stash first, then stop.

Confirm remotes:
- `git remote -v`
If `upstream` is missing:
- Ask the user for the upstream repo URL (default: `https://github.com/qwibitai/nanoclaw.git`).
- Add it: `git remote add upstream <user-provided-url>`
- Then: `git fetch upstream --prune`

Determine the upstream branch name:
- `git branch -r | grep upstream/`
- If `upstream/main` exists, use `main`.
- If only `upstream/master` exists, use `master`.
- Otherwise, ask the user which branch to use.
- Store this as UPSTREAM_BRANCH for all subsequent commands. Every command below that references `upstream/main` should use `upstream/$UPSTREAM_BRANCH` instead.

Fetch:
- `git fetch upstream --prune`

# Step 1: Create a safety net
Capture current state:
- `HASH=$(git rev-parse --short HEAD)`
- `TIMESTAMP=$(date +%Y%m%d-%H%M%S)`

Create backup branch and tag (using timestamp to avoid collisions on retry):
- `git branch backup/pre-update-$HASH-$TIMESTAMP`
- `git tag pre-update-$HASH-$TIMESTAMP`

Save the tag name for later reference in the summary and rollback instructions.

# Step 2: Preview what upstream changed (no edits yet)
Compute common base:
- `BASE=$(git merge-base HEAD upstream/$UPSTREAM_BRANCH)`

Show upstream commits since BASE:
- `git log --oneline $BASE..upstream/$UPSTREAM_BRANCH`

Show local commits since BASE (custom drift):
- `git log --oneline $BASE..HEAD`

Show file-level impact from upstream:
- `git diff --name-only $BASE..upstream/$UPSTREAM_BRANCH`

Bucket the upstream changed files:
- **Skills** (`.claude/skills/`): unlikely to conflict unless the user edited an upstream skill
- **Source** (`src/`): may conflict if user modified the same files
- **Build/config** (`package.json`, `package-lock.json`, `tsconfig*.json`, `container/`, `launchd/`): review needed
- **Other**: docs, tests, misc

# Step 2.5: Fork surface audit (hotspot identification)
Before picking a strategy, measure how much the fork already diverges from upstream on the files upstream is about to touch. High divergence = high conflict risk.

For each file in the upstream changeset, compute line-count divergence:
- `git diff --shortstat upstream/$UPSTREAM_BRANCH...HEAD -- <file>`

Identify the top 5 most-diverged files and present them as **hotspots** to the user. Examples from real NanoClaw forks: `src/channels/whatsapp.ts`, `src/index.ts`, `src/credential-proxy.ts`, `container/agent-runner/src/index.ts`. Flag any hotspot that upstream commits touch — those are the likely-conflict commits.

# Step 2.6: Duplicate and architectural-conflict detection
Before recommending a strategy, check for two traps:

**Duplicates** — commits the fork already merged under a different SHA. Upstream subjects may be identical to local commits:
- `git log HEAD --oneline --since="6 months ago" | awk -F' ' '{$1=""; print $0}' | sort > /tmp/local-subjects.txt`
- `git log $BASE..upstream/$UPSTREAM_BRANCH --oneline | awk -F' ' '{$1=""; print $0}' | sort > /tmp/upstream-subjects.txt`
- `comm -12 /tmp/local-subjects.txt /tmp/upstream-subjects.txt`

For each subject match, verify with a grep for a distinctive token from the commit (e.g., a new field name, a class name). If confirmed duplicate, **exclude from the cherry-pick list** and note it in the summary.

**Architectural conflicts** — upstream commits that rewrite a hotspot file end-to-end (50%+ of lines). These can't be safely cherry-picked without a separate design decision:
- For each upstream commit: `git show --shortstat <sha>` → compute `(insertions+deletions) / total-lines-in-target-file`.
- If > 0.5 on any hotspot file, flag as "architectural" and **ask the user** before including. Typical outcome: skip and document as debt.

Present these buckets to the user and ask them to choose one path using AskUserQuestion:
- A) **Full update**: merge all upstream changes
- B) **Selective update**: cherry-pick specific upstream commits
- C) **Abort**: they only wanted the preview
- D) **Rebase mode**: advanced, linear history (warn: resolves conflicts per-commit)

If Abort: stop here.

# Step 3: Conflict preview (before committing anything)
If Full update or Rebase:
- Dry-run merge to preview conflicts. Run these as a single chained command so the abort always executes:
  ```
  git merge --no-commit --no-ff upstream/$UPSTREAM_BRANCH; git diff --name-only --diff-filter=U; git merge --abort
  ```
- If conflicts were listed: show them and ask user if they want to proceed.
- If no conflicts: tell user it is clean and proceed.

# Step 4A: Full update (MERGE, default)
Run:
- `git merge upstream/$UPSTREAM_BRANCH --no-edit`

If conflicts occur:
- Run `git status` and identify conflicted files.
- For each conflicted file:
  - Open the file.
  - Resolve only conflict markers.
  - Preserve intentional local customizations.
  - Incorporate upstream fixes/improvements.
  - Do not refactor surrounding code.
  - `git add <file>`
- When all resolved:
  - If merge did not auto-commit: `git commit --no-edit`

# Step 4B: Selective update (CHERRY-PICK)
If user chose Selective:
- Recompute BASE if needed: `BASE=$(git merge-base HEAD upstream/$UPSTREAM_BRANCH)`
- Show commit list again: `git log --oneline $BASE..upstream/$UPSTREAM_BRANCH`
- Filter out merge commits from the candidate list (`git log --no-merges`). Merge commits fail without `-m <parent>`; almost always the feature commit from the PR branch is the one to pick, not the merge.
- Ask user which commit hashes they want.
- Apply one chain at a time: `git cherry-pick <hash1> <hash2> ...`

If conflicts during cherry-pick:
- Resolve only conflict markers, then:
  - `git add <file>`
  - `git cherry-pick --continue`
If user wants to stop:
  - `git cherry-pick --abort`

**Lockfile conflicts (`package-lock.json`, `package-lock.json` under subpackages):**
- Do NOT try to resolve markers manually — lockfiles are machine-generated.
- Take upstream's version and regenerate: `git checkout --theirs package-lock.json && npm install`
- Then `git add package-lock.json && git cherry-pick --continue`

**Build-config conflicts (`Dockerfile`, `tsconfig.json`):**
- Treat as source-file conflicts but expect layer-ordering or path resolution changes. Run `docker build` (if Dockerfile) or `npx tsc --noEmit` (if tsconfig) after resolving, before `--continue`.

**Type-chain cherry-picks (commits that add/move fields across files):**
- After each commit in the chain, run `npx tsc --noEmit` (host) AND `(cd container/agent-runner && npx tsc --noEmit)`. Catches interface drift that `npm run build` at the end would bury under many errors.
- If interfaces in the fork need an extra field the upstream commit assumed, add it in a follow-up `fix(types): ...` commit rather than amending the cherry-pick. Keeps upstream SHAs cleanly traceable.

**Cascade conflicts (same file conflicts on 2+ consecutive commits):**
- After the first resolution, run `git diff HEAD~..HEAD -- <file>` to confirm the resolution applied cleanly.
- If the second cherry-pick conflicts in the same file again: inspect whether the two upstream commits are semantically layered (B edits A's additions). If yes, resolve by re-applying the upstream intent on top of your resolved file. If no, the conflict is spurious — abort both cherry-picks and pick them in a single `git cherry-pick <A>^..<B>` which may auto-rebase them together.
- Abort criterion: if the same file conflicts 3+ times in a chain, stop — the commits may need a merge instead of cherry-pick, or should be applied as a single squash.

# Step 4C: Rebase (only if user explicitly chose option D)
Run:
- `git rebase upstream/$UPSTREAM_BRANCH`

If conflicts:
- Resolve conflict markers only, then:
  - `git add <file>`
  - `git rebase --continue`
If it gets messy (more than 3 rounds of conflicts):
  - `git rebase --abort`
  - Recommend merge instead.

# Step 5: Validation
Run:
- `npm run build`
- `npm test` (do not fail the flow if tests are not configured)

If build fails:
- Show the error.
- Only fix issues clearly caused by the merge (missing imports, type mismatches from merged code).
- Do not refactor unrelated code.
- If unclear, ask the user before making changes.
- **Type mismatches at fork/upstream boundary**: if fork interfaces are missing fields that upstream code now uses, add them in a follow-up `fix(types): ...` commit (see Step 4B type-chain guidance). Don't amend a cherry-picked SHA.

If the update introduced ESLint (or any lint tool the fork didn't previously have):
- Pre-existing lint errors/warnings in fork-only files are expected. Document in the summary as debt but do not block.
- Only fix lint errors clearly introduced by the new cherry-picks (e.g., unused imports in files the merge touched).

# Step 6: Breaking changes check
After validation succeeds, check if the update introduced any breaking changes.

Determine which CHANGELOG entries are new by diffing against the backup tag:
- `git diff <backup-tag-from-step-1>..HEAD -- CHANGELOG.md`

Parse the diff output for lines starting with `+[BREAKING]`. Each such line is one breaking change entry. The format is:
```
[BREAKING] <description>. Run `/<skill-name>` to <action>.
```

If no `[BREAKING]` lines are found:
- Skip this step silently. Proceed to Step 7 (skill updates check).

If one or more `[BREAKING]` lines are found:
- Display a warning header to the user: "This update includes breaking changes that may require action:"
- For each breaking change, display the full description.
- Collect all skill names referenced in the breaking change entries (the `/<skill-name>` part).
- Use AskUserQuestion to ask the user which migration skills they want to run now. Options:
  - One option per referenced skill (e.g., "Run /add-whatsapp to re-add WhatsApp channel")
  - "Skip — I'll handle these manually"
- Set `multiSelect: true` so the user can pick multiple skills if there are several breaking changes.
- For each skill the user selects, invoke it using the Skill tool.
- After all selected skills complete (or if user chose Skip), proceed to Step 7 (skill updates check).

# Step 7: Check for skill updates
After the summary, check if skills are distributed as branches in this repo:
- `git branch -r --list 'upstream/skill/*'`

If any `upstream/skill/*` branches exist:
- Use AskUserQuestion to ask: "Upstream has skill branches. Would you like to check for skill updates?"
  - Option 1: "Yes, check for updates" (description: "Runs /update-skills to check for and apply skill branch updates")
  - Option 2: "No, skip" (description: "You can run /update-skills later any time")
- If user selects yes, invoke `/update-skills` using the Skill tool.
- After the skill completes (or if user selected no), proceed to Step 8.

# Step 8: Summary + rollback instructions
Show:
- Backup tag: the tag name created in Step 1
- New HEAD: `git rev-parse --short HEAD`
- Upstream HEAD: `git rev-parse --short upstream/$UPSTREAM_BRANCH`
- Conflicts resolved (list files, if any)
- Breaking changes applied (list skills run, if any)
- Remaining local diff vs upstream: `git diff --name-only upstream/$UPSTREAM_BRANCH..HEAD`

Tell the user:
- To rollback: `git reset --hard <backup-tag-from-step-1>`
- Backup branch also exists: `backup/pre-update-<HASH>-<TIMESTAMP>`
- Restart the service to apply changes:
  - If using launchd: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist && launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist`
  - If running manually: restart `npm run dev`

---

# Case study: blissito fork update 2026-04-17 (334 commits behind)

Real dolor points this protocol update addresses:

1. **4 of 14 targeted commits were duplicates** (already merged locally under different SHAs). Detected by commit-subject match: `ee599b9` (reply context) matched local `8023342`; `db3440f`/`f77f9ce` (SDK + threshold) matched package.json / agent-runner state; `67020f9` (session cleanup) matched existing `src/session-cleanup.ts`. Without Step 2.6, these would have wasted 20+ minutes of cherry-pick attempts.

2. **Architectural conflict averted on OneCLI** (`e936961`). Upstream replaced `src/credential-proxy.ts` wholesale; fork had 760 lines of custom OAuth + fallback + Vault logic. Categorized as "architectural" via Step 2.6's 50% rewrite heuristic, skipped, documented as debt in memory. Keeps the door open to evaluate OneCLI in a dedicated session rather than pretending it's a regular cherry-pick.

3. **Lockfile conflict on ESLint** (`30ebcaa`). Merge markers in `package-lock.json` are unresolvable by hand. Recipe: `git checkout --theirs package-lock.json && npm install`.

4. **Merge commit in cherry-pick list** (`b2fa85b` for channel-formatting). Failed with "is a merge but no -m option was given". The feature commit (`7bba21a`) was the right pick. Step 4B's `--no-merges` filter prevents this.

5. **Type drift across a 4-commit chain** (scheduled-task `script` field: `675acff` → `42d098c` → `0f283cb` → `9f5aff9`). Upstream commits passed `script` through the call chain assuming interfaces supported it; fork's `ContainerInput` (both host and agent-runner) didn't. Final `npm run build` caught it; intermediate `tsc --noEmit` would have caught it at the first commit. Fixed via a separate `fix(types):` commit rather than amending upstream SHAs.

6. **Fork hotspots known upfront changed the whole strategy**. Listing `credential-proxy.ts` (+713), `whatsapp.ts` (+1044), `index.ts` (+986), `agent-runner/index.ts` (+447) before picking a strategy made the user's decision about OneCLI obvious before any git operation ran.
