#!/usr/bin/env bash
#
# formmy-rescue-message.sh — push a single text message into a WABA chat
# bypassing the agent. Used to recover messages that the agent generated
# but the host suppressed or failed to deliver. See
# docs/formmy-nanoclaw-bridge.md → "Rescate manual de un mensaje perdido".
#
# Usage:
#   scripts/formmy-rescue-message.sh <phone> <integration_id> "<text>"
#
#   <phone>           E.164 without '+' (e.g. 5217717029744)
#   <integration_id>  Mongo ObjectId from formmy_jid_mapping
#   <text>            The message body. Newlines via "\n" literal in the
#                     arg are forwarded as JSON-escaped newlines.
#
# Run from /home/nanoclaw/app (or any directory; the script resolves .env
# relative to itself).
#
# Exit codes:
#   0  → 2xx from Formmy, message handed to Meta (wamid printed)
#   1  → missing argument / env / .env not found
#   2  → Formmy returned non-2xx (body printed)

set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <phone> <integration_id> \"<text>\"" >&2
  exit 1
fi

phone="$1"
integration_id="$2"
text="$3"

# Resolve .env from project root (one level up from scripts/)
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="$script_dir/../.env"
if [[ ! -f "$env_file" ]]; then
  echo "error: .env not found at $env_file" >&2
  exit 1
fi

secret="$(grep '^FORMMY_CHANNEL_SECRET=' "$env_file" | cut -d= -f2-)"
callback="$(grep '^FORMMY_CALLBACK_URL=' "$env_file" | cut -d= -f2-)"
if [[ -z "$secret" || -z "$callback" ]]; then
  echo "error: FORMMY_CHANNEL_SECRET and FORMMY_CALLBACK_URL must be set in $env_file" >&2
  exit 1
fi

# Build payload via python so the text is properly JSON-escaped (handles
# quotes, newlines, emojis, etc) without shell-quoting hell.
payload="$(python3 -c '
import json, sys
print(json.dumps({
  "phone_number": sys.argv[1],
  "integration_id": sys.argv[2],
  "type": "text",
  "text": sys.argv[3],
}))
' "$phone" "$integration_id" "$text")"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

status="$(curl -sS -o "$tmp" -w '%{http_code}' \
  -X POST "$callback" \
  -H "Authorization: Bearer $secret" \
  -H "Content-Type: application/json" \
  -d "$payload")"

body="$(cat "$tmp")"

if [[ "$status" != 2* ]]; then
  echo "error: Formmy returned status $status" >&2
  echo "$body" >&2
  exit 2
fi

wamid="$(python3 -c '
import json, sys
try:
  print(json.loads(sys.stdin.read())["whatsappResponse"]["messages"][0]["id"])
except Exception:
  print("(no wamid in response)")
' <<<"$body")"

echo "delivered: $wamid"
