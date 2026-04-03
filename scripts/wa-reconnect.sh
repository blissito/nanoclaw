#!/bin/bash
# Reconnect WhatsApp on production (DigitalOcean droplet).
# Uses pairing code — more reliable than QR for remote/headless setups.
#
# Usage: ./scripts/wa-reconnect.sh [phone_number]
#   phone_number: with country code, no spaces/dashes (default: 527712412825)
#
# Steps:
#   1. Stops nanoclaw service
#   2. Clears old WhatsApp auth
#   3. Starts NanoClaw with WHATSAPP_PHONE_NUMBER to get a pairing code
#   4. Displays the code — enter it in WhatsApp > Linked Devices > Link with phone number
#   5. Waits for auth to complete, then restarts the service

set -euo pipefail

PHONE="${1:-527717759013}"
HOST="root@134.199.239.173"
APP_DIR="/home/nanoclaw/app"

echo "==> Stopping nanoclaw service..."
ssh "$HOST" "systemctl stop nanoclaw || true; pkill -u nanoclaw -f 'node dist/index' || true; sleep 2"

echo "==> Clearing WhatsApp auth..."
ssh "$HOST" "rm -rf $APP_DIR/store/auth/* $APP_DIR/store/pairing-code.txt"

echo "==> Starting NanoClaw to get pairing code..."
ssh "$HOST" "cd $APP_DIR && sudo -u nanoclaw WHATSAPP_PHONE_NUMBER=$PHONE WHATSAPP_RECONNECT_MODE=1 node dist/index.js &"

# Wait for pairing code file
echo "==> Waiting for pairing code..."
for i in $(seq 1 20); do
  CODE=$(ssh "$HOST" "cat $APP_DIR/store/pairing-code.txt 2>/dev/null" || true)
  if [ -n "$CODE" ]; then
    echo ""
    echo "========================================="
    echo "  PAIRING CODE: $CODE"
    echo "========================================="
    echo ""
    echo "Go to WhatsApp > Linked Devices > Link a Device > Link with phone number"
    echo "Enter the code above."
    break
  fi
  sleep 1
done

if [ -z "${CODE:-}" ]; then
  echo "ERROR: Timed out waiting for pairing code"
  ssh "$HOST" "pkill -u nanoclaw -f 'node dist/index' || true"
  exit 1
fi

# Wait for auth to complete
echo ""
echo "==> Waiting for WhatsApp to connect..."
for i in $(seq 1 60); do
  if ssh "$HOST" "test -f $APP_DIR/store/auth/creds.json" 2>/dev/null; then
    echo "==> Connected! Restarting nanoclaw service..."
    ssh "$HOST" "pkill -u nanoclaw -f 'node dist/index' || true; sleep 2; systemctl start nanoclaw"
    echo "==> Done! WhatsApp reconnected."
    exit 0
  fi
  sleep 2
done

echo "ERROR: Timed out waiting for connection"
ssh "$HOST" "pkill -u nanoclaw -f 'node dist/index' || true"
exit 1
