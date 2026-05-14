#!/usr/bin/env bash
#
# eval-day.sh — generate a human-readable conversation evaluation for a
# given day. Three sections:
#
#   1. OVERVIEW           one row per active chat: counts, last activity,
#                         flag "esperando bot" if last msg was the customer.
#   2. TRANSCRIPTS        per-chat chronological dump for any chat with
#                         >= MIN_MSGS messages on the date. Each line is
#                         "[HH:MM:SS] CLI|BOT: <content first 180 chars>".
#   3. NARRATION HITS     journalctl events where the post-MCP narration
#                         filter suppressed an agent output (audit feed
#                         for false positives — see src/index.ts).
#
# Use it to triage daily volume, spot stuck chats, and check whether the
# narrow narration regex is firing on real content. Designed to be cheap
# (single sqlite3 + one journalctl grep) and self-contained.
#
# Usage:
#   # On the droplet (default DB path):
#   bash scripts/eval-day.sh                         # today
#   bash scripts/eval-day.sh 2026-05-12              # specific date
#   MIN_MSGS=5 bash scripts/eval-day.sh              # change drill threshold
#
#   # From your laptop (agent forwarding to use the github key on the host):
#   ssh -A root@<droplet-ip> 'bash -s' < scripts/eval-day.sh
#   ssh -A root@<droplet-ip> 'bash -s -- 2026-05-12' < scripts/eval-day.sh
#
#   # Pipe to file/less for long output:
#   bash scripts/eval-day.sh > eval-$(date +%F).txt
#   bash scripts/eval-day.sh | less -R
#
# Env vars:
#   NANOCLAW_DB    sqlite DB path (default /home/nanoclaw/app/store/messages.db)
#   MIN_MSGS       minimum message count for transcript drill-down (default 3)
#   CHAT_FILTER    SQL LIKE pattern to scope chats (default 'formmy_%').
#                  Use '%' for all chats including groups.
#
# Exit codes:
#   0  → ran clean (no data is not an error)
#   1  → DB not found / unreadable
#
# Future (Nivel 3): pipe the transcript section into Claude/Sonnet as a
# judge to classify outcomes (cerró venta / pending / leaked narración /
# perdió por X / error técnico) and aggregate. Reuse `--date` and capture
# stdout — the format is already structured enough for an LLM to parse.

set -euo pipefail

DATE="${1:-$(date +%Y-%m-%d)}"
DB="${NANOCLAW_DB:-/home/nanoclaw/app/store/messages.db}"
MIN_MSGS="${MIN_MSGS:-3}"
CHAT_FILTER="${CHAT_FILTER:-formmy_%}"

if [ ! -f "$DB" ]; then
  echo "DB not found: $DB" >&2
  echo "Run on the droplet, or set NANOCLAW_DB to a local copy." >&2
  exit 1
fi

echo "═══════════════════════════════════════════════════════════════"
echo "  NanoClaw conversation eval — $DATE"
echo "  DB: $DB | filter: $CHAT_FILTER | drill ≥ $MIN_MSGS msgs"
echo "═══════════════════════════════════════════════════════════════"
echo

# ─── 1. OVERVIEW ──────────────────────────────────────────────────────
echo "──── OVERVIEW ────"
sqlite3 -header -column "$DB" "
SELECT
  replace(replace(chat_jid, 'formmy_', ''), '@s.whatsapp.net', '') AS chat,
  COUNT(*) AS msgs,
  SUM(CASE WHEN is_from_me=0 THEN 1 ELSE 0 END) AS cli,
  SUM(CASE WHEN is_from_me=1 THEN 1 ELSE 0 END) AS bot,
  substr(MAX(timestamp), 12, 5) AS ultimo,
  CASE
    WHEN MAX(CASE WHEN is_from_me=0 THEN timestamp END) >
         COALESCE(MAX(CASE WHEN is_from_me=1 THEN timestamp END), '')
    THEN 'esperando bot'
    ELSE 'ok'
  END AS estado
FROM messages
WHERE date(timestamp) = date('$DATE')
  AND chat_jid LIKE '$CHAT_FILTER'
GROUP BY chat_jid
ORDER BY MAX(timestamp) DESC;
"
echo

# ─── 2. TRANSCRIPTS ───────────────────────────────────────────────────
echo "──── TRANSCRIPTS (chats with ≥ $MIN_MSGS msgs) ────"

# Fetch chat list once into bash array.
mapfile -t CHATS < <(sqlite3 "$DB" "
SELECT chat_jid
FROM messages
WHERE date(timestamp) = date('$DATE')
  AND chat_jid LIKE '$CHAT_FILTER'
GROUP BY chat_jid
HAVING COUNT(*) >= $MIN_MSGS
ORDER BY MAX(timestamp);
")

if [ "${#CHATS[@]}" -eq 0 ]; then
  echo "  (no chats with ≥ $MIN_MSGS messages on $DATE)"
else
  for chat in "${CHATS[@]}"; do
    phone="${chat#formmy_}"
    phone="${phone%@s.whatsapp.net}"
    echo
    echo "─── $phone ($chat) ───"
    sqlite3 -separator $'\t' "$DB" "
      SELECT substr(timestamp, 12, 8),
             CASE is_from_me WHEN 1 THEN 'BOT' ELSE 'CLI' END,
             replace(substr(content, 1, 180), char(10), ' / ')
      FROM messages
      WHERE chat_jid = '$chat'
        AND date(timestamp) = date('$DATE')
      ORDER BY timestamp;
    " | awk -F'\t' '{printf "  [%s] %s: %s\n", $1, $2, $3}'
  done
fi
echo

# ─── 3. NARRATION FILTER HITS ─────────────────────────────────────────
echo "──── NARRATION FILTER HITS ────"
if command -v journalctl >/dev/null 2>&1; then
  TOMORROW="$(date -d "$DATE + 1 day" +%Y-%m-%d 2>/dev/null || date -v+1d -j -f %Y-%m-%d "$DATE" +%Y-%m-%d)"
  hits="$(journalctl -u nanoclaw \
            --since "$DATE 00:00:00" --until "$TOMORROW 00:00:00" \
            --no-pager 2>/dev/null \
          | grep -F 'post-mcp-narration' || true)"
  if [ -z "$hits" ]; then
    echo "  (no narration suppressions logged on $DATE)"
  else
    echo "$hits" | sed -E 's/.*chatJid":"formmy_([^@"]+)[^"]*".*pattern":"([^"]+)".*preview":"([^"]{0,100}).*/  \1 | \2 | \3/'
  fi
else
  echo "  (journalctl unavailable — run on the droplet to see filter hits)"
fi
echo

echo "═══════════════════════════════════════════════════════════════"
echo "  done — pipe to less, save to file, or feed into an LLM judge."
echo "═══════════════════════════════════════════════════════════════"
