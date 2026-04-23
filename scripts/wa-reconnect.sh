#!/bin/bash
# Reconnect WhatsApp on production (DigitalOcean droplet).
# Uses pairing code — more reliable than QR for remote/headless setups.
#
# Usage: ./scripts/wa-reconnect.sh [phone_number]
#   phone_number: digits only, with country code, no '+' or separators.
#                 Default: 527717759013 (NanoClaw main, MX without legacy "1")
#
# Notes on the MX number format:
#   WhatsApp México accepts both "521..." (legacy mobile) and "52..." (new).
#   The number you pass MUST match the number currently signed in on the
#   phone where you'll enter the pairing code, or WhatsApp will reject the
#   code with "el número de teléfono no es correcto". When in doubt, look at
#   "me.id" in store/auth/creds.json after a successful pair to learn the
#   exact format that account uses (e.g. 5217717759013 vs 527717759013).
#
# Steps:
#   1. Stops nanoclaw service
#   2. Clears old WhatsApp auth
#   3. Starts NanoClaw with WHATSAPP_PHONE_NUMBER to get a pairing code
#   4. Displays the code — enter it in WhatsApp > Linked Devices > Link with
#      phone number
#   5. Waits for the device to be linked (creds.json: registered=true), then
#      restarts the service so it picks up the new auth.

set -euo pipefail

PHONE="${1:-527717759013}"
HOST="root@134.199.239.173"
APP_DIR="/home/nanoclaw/app"

# Validate phone number: digits only, 10-15 chars (E.164 limits).
if ! [[ "$PHONE" =~ ^[0-9]{10,15}$ ]]; then
  echo "ERROR: phone must be 10-15 digits, got: $PHONE" >&2
  exit 1
fi

echo "==> Stopping nanoclaw service..."
ssh "$HOST" "systemctl stop nanoclaw || true; pkill -u nanoclaw -f 'node dist/index' || true; sleep 2"

echo "==> Clearing WhatsApp auth..."
ssh "$HOST" "rm -rf $APP_DIR/store/auth/* $APP_DIR/store/pairing-code.txt /tmp/wa-pair.log /tmp/wa-pair.pid"

echo "==> Starting NanoClaw in pairing mode (detached)..."
# nohup + redirect so the process survives the SSH session and we can tail
# the log later. Capture the PID so we can clean up if anything goes wrong.
ssh "$HOST" "cd $APP_DIR && sudo -u nanoclaw nohup env WHATSAPP_PHONE_NUMBER=$PHONE WHATSAPP_RECONNECT_MODE=1 node dist/index.js > /tmp/wa-pair.log 2>&1 & echo \$! > /tmp/wa-pair.pid; disown"

# Wait for pairing code file. Baileys writes it ~3s after socket connect.
echo "==> Waiting for pairing code..."
CODE=""
for i in $(seq 1 30); do
  CODE=$(ssh "$HOST" "cat $APP_DIR/store/pairing-code.txt 2>/dev/null" || true)
  if [ -n "$CODE" ]; then
    echo ""
    echo "========================================="
    echo "  PAIRING CODE: $CODE"
    echo "  (for phone: +$PHONE)"
    echo "========================================="
    echo ""
    echo "On your phone:"
    echo "  WhatsApp > Settings > Linked Devices > Link a Device"
    echo "  > Link with phone number > enter the code above"
    echo ""
    echo "If WhatsApp says 'el número de teléfono no es correcto', the phone"
    echo "number passed to this script does not match the WhatsApp account on"
    echo "the device. Cancel (Ctrl-C), pass the right number as arg 1, retry."
    break
  fi
  sleep 1
done

if [ -z "$CODE" ]; then
  echo "ERROR: timed out waiting for pairing code" >&2
  ssh "$HOST" "kill \$(cat /tmp/wa-pair.pid 2>/dev/null) 2>/dev/null || true; pkill -u nanoclaw -f 'node dist/index' || true"
  exit 1
fi

# Wait for actual registration. Pairing completes when creds.json has
# registered=true — NOT when the file exists (it's created on socket connect
# with registered=false). 180s gives the user time to open WA, navigate to
# Linked Devices, and type the code without rushing.
echo "==> Waiting for device link (up to 180s)..."
for i in $(seq 1 90); do
  REGISTERED=$(ssh "$HOST" "python3 -c 'import json; d=json.load(open(\"$APP_DIR/store/auth/creds.json\")); print(d.get(\"registered\", False))' 2>/dev/null" || echo "False")
  if [ "$REGISTERED" = "True" ]; then
    echo ""
    echo "==> Device linked. Restarting nanoclaw service..."
    ssh "$HOST" "kill \$(cat /tmp/wa-pair.pid 2>/dev/null) 2>/dev/null || true; pkill -u nanoclaw -f 'node dist/index' || true; sleep 2; systemctl start nanoclaw"
    echo "==> Done. WhatsApp reconnected."
    # Show the registered number for confirmation.
    ME_ID=$(ssh "$HOST" "python3 -c 'import json; d=json.load(open(\"$APP_DIR/store/auth/creds.json\")); print(d.get(\"me\", {}).get(\"id\", \"?\"))' 2>/dev/null" || echo "?")
    echo "==> Registered as: $ME_ID"
    exit 0
  fi
  sleep 2
done

echo "ERROR: timed out waiting for device link" >&2
echo "  Check /tmp/wa-pair.log on $HOST for clues:"
echo "  ssh $HOST 'tail -50 /tmp/wa-pair.log'"
ssh "$HOST" "kill \$(cat /tmp/wa-pair.pid 2>/dev/null) 2>/dev/null || true; pkill -u nanoclaw -f 'node dist/index' || true"
exit 1
