#!/usr/bin/env bash
# Reclaim disk from orphaned agent session transcripts.
#
# Each group's active session id lives in the sqlite `sessions` table. The
# SDK writes an append-only `<session-id>.jsonl` per session under
# data/sessions/<folder>/.claude/projects/-workspace-group/. When a session is
# rotated (auto-rotate on size), /cleared, or superseded, its old .jsonl is left
# behind — never read again but still on disk. This sweep deletes every .jsonl
# whose id is NOT the group's current active session. Active sessions are never
# touched. Safe to run repeatedly (idempotent).
#
# Intended to run nightly via nanoclaw-session-sweep.timer.
set -euo pipefail

APP_ROOT="${NANOCLAW_APP_ROOT:-/home/nanoclaw/app}"
DB="$APP_ROOT/store/messages.db"
SESS="$APP_ROOT/data/sessions"

[ -f "$DB" ] || { echo "session-sweep: DB not found at $DB" >&2; exit 0; }
[ -d "$SESS" ] || { echo "session-sweep: sessions dir not found at $SESS" >&2; exit 0; }

declare -A ACTIVE
while IFS='|' read -r folder sid; do
  [ -n "$folder" ] && ACTIVE["$folder"]="$sid"
done < <(sqlite3 "$DB" "SELECT group_folder, session_id FROM sessions;")

freed=0
del=0
shopt -s nullglob
for f in "$SESS"/*/.claude/projects/-workspace-group/*.jsonl; do
  folder=$(echo "$f" | sed -E 's#.*/sessions/([^/]+)/.claude.*#\1#')
  id=$(basename "$f" .jsonl)
  if [ "$id" != "${ACTIVE[$folder]:-}" ]; then
    sz=$(stat -c %s "$f")
    freed=$((freed + sz))
    del=$((del + 1))
    rm -f "$f"
  fi
done

echo "session-sweep: deleted $del orphan transcript(s), freed $(numfmt --to=iec "$freed" 2>/dev/null || echo "${freed}B")"
