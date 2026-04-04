#!/bin/bash
# Create a clean NanoClaw snapshot for client deployment.
#
# End-to-end flow (runs from your local machine):
#   1. Snapshots the production droplet
#   2. Creates a temporary clone from that snapshot
#   3. SSHs into the clone and sanitizes all secrets
#   4. Takes a clean snapshot of the sanitized clone
#   5. Destroys the clone
#
# Usage:
#   ./scripts/prepare-snapshot.sh [snapshot-name]
#   Default snapshot name: nanoclaw-client-YYYY-MM-DD
#
# Prerequisites:
#   - doctl CLI authenticated (doctl auth init)
#   - SSH access to production droplet
#
# What gets cleaned on the clone:
#   - .env values (API keys, OAuth tokens, DB URIs — structure preserved)
#   - WhatsApp auth (store/auth/) — linked device session keys
#   - WhatsApp pairing artifacts (pairing-code.txt, qr-code.txt, qr-auth.html)
#   - SQLite database (store/messages.db) — message history, group configs
#   - Container sessions (data/sessions/) — per-group agent state and memory
#   - Group data (groups/) — per-group CLAUDE.md and attachments
#   - SSH keys — personal keys in root and nanoclaw home
#   - Shell history — may contain pasted tokens or passwords
#   - Mount allowlist (~/.config/nanoclaw/) — personal path references
#   - Systemd journal — may contain logged secrets
#   - Docker containers and images — stale agent containers
#
# After deploying the clean snapshot to a new droplet, the client needs to:
#   1. Fill in .env with their own keys (see .env.template)
#   2. Rebuild the container image: ./container/build.sh
#   3. Run /setup from Claude Code to link WhatsApp and register groups

set -euo pipefail

# --- Config ---
PROD_DROPLET_NAME="nanoclaw-prod"
CLONE_NAME="nanoclaw-snapshot-tmp"
CLONE_SIZE="s-1vcpu-1gb"        # Smallest — just needs to boot and get sanitized
CLONE_REGION="nyc1"             # Same region as prod for fast snapshot
SNAPSHOT_NAME="${1:-nanoclaw-client-$(date +%Y-%m-%d)}"
APP_DIR="/home/nanoclaw/app"

echo "=== NanoClaw Client Snapshot Builder ==="
echo ""
echo "Snapshot name: $SNAPSHOT_NAME"
echo ""

# --- Helper ---
wait_for_action() {
  local droplet_id="$1"
  local action_id="$2"
  local description="$3"
  echo -n "  Waiting for $description..."
  while true; do
    status=$(doctl compute droplet-action get "$droplet_id" --action-id "$action_id" --format Status --no-header)
    if [ "$status" = "completed" ]; then
      echo " done"
      return 0
    elif [ "$status" = "errored" ]; then
      echo " FAILED"
      return 1
    fi
    echo -n "."
    sleep 10
  done
}

# ============================================================
# Step 1: Snapshot production droplet
# ============================================================
echo "[1/5] Snapshotting production droplet..."

PROD_ID=$(doctl compute droplet list --format Name,ID --no-header | grep "^${PROD_DROPLET_NAME} " | awk '{print $2}')
if [ -z "$PROD_ID" ]; then
  echo "ERROR: Droplet '$PROD_DROPLET_NAME' not found. Available droplets:"
  doctl compute droplet list --format Name,ID,Region --no-header
  exit 1
fi
echo "  Found $PROD_DROPLET_NAME (ID: $PROD_ID)"

TEMP_SNAP_NAME="nanoclaw-tmp-$(date +%s)"
ACTION_JSON=$(doctl compute droplet-action snapshot "$PROD_ID" --snapshot-name "$TEMP_SNAP_NAME" --format ID --no-header)
wait_for_action "$PROD_ID" "$ACTION_JSON" "snapshot"

TEMP_SNAP_ID=$(doctl compute snapshot list --format Name,ID --no-header | grep "^${TEMP_SNAP_NAME} " | awk '{print $2}')
echo "  Temporary snapshot created: $TEMP_SNAP_NAME (ID: $TEMP_SNAP_ID)"

# ============================================================
# Step 2: Create clone from snapshot
# ============================================================
echo ""
echo "[2/5] Creating temporary clone..."

doctl compute droplet create "$CLONE_NAME" \
  --image "$TEMP_SNAP_ID" \
  --size "$CLONE_SIZE" \
  --region "$CLONE_REGION" \
  --ssh-keys "$(doctl compute ssh-key list --format ID --no-header | head -1)" \
  --wait \
  --no-header

CLONE_IP=$(doctl compute droplet list --format Name,PublicIPv4 --no-header | grep "^${CLONE_NAME} " | awk '{print $2}')
CLONE_ID=$(doctl compute droplet list --format Name,ID --no-header | grep "^${CLONE_NAME} " | awk '{print $2}')
echo "  Clone ready: $CLONE_IP (ID: $CLONE_ID)"

# Wait for SSH to be available
echo -n "  Waiting for SSH..."
for i in $(seq 1 30); do
  if ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no "root@$CLONE_IP" "true" 2>/dev/null; then
    echo " ready"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo " TIMEOUT — could not connect to clone"
    echo "  Clean up manually: doctl compute droplet delete $CLONE_ID --force"
    exit 1
  fi
  echo -n "."
  sleep 5
done

# ============================================================
# Step 3: Sanitize the clone
# ============================================================
echo ""
echo "[3/5] Sanitizing clone..."

ssh -o StrictHostKeyChecking=no "root@$CLONE_IP" bash <<'REMOTE_SCRIPT'
set -euo pipefail
APP_DIR="/home/nanoclaw/app"

# Stop service if running
systemctl stop nanoclaw 2>/dev/null || true
sleep 2

# Kill any running containers
docker kill $(docker ps -q) 2>/dev/null || true
docker rm $(docker ps -aq) 2>/dev/null || true
# Remove container images (client will rebuild)
docker rmi $(docker images -q) 2>/dev/null || true
docker system prune -af 2>/dev/null || true

echo "  [1/8] Cleaning .env..."
if [ -f "$APP_DIR/.env" ]; then
  sed -i 's/=.*/=/' "$APP_DIR/.env"
fi

echo "  [2/8] Cleaning WhatsApp auth..."
rm -rf "$APP_DIR/store/auth"
rm -f "$APP_DIR/store/pairing-code.txt"
rm -f "$APP_DIR/store/qr-code.txt"
rm -f "$APP_DIR/store/qr-auth.html"
rm -f "$APP_DIR/store/auth-status.txt"

echo "  [3/8] Cleaning message database..."
rm -f "$APP_DIR/store/messages.db"
rm -f "$APP_DIR/store/messages.db-shm"
rm -f "$APP_DIR/store/messages.db-wal"

echo "  [4/8] Cleaning container sessions and groups..."
rm -rf "$APP_DIR/data/sessions"
rm -rf "$APP_DIR/groups"

echo "  [5/8] Cleaning SSH keys..."
rm -f /root/.ssh/id_* /root/.ssh/known_hosts
rm -f /home/nanoclaw/.ssh/id_* /home/nanoclaw/.ssh/known_hosts 2>/dev/null || true

echo "  [6/8] Cleaning shell history..."
> /root/.bash_history
> /root/.zsh_history 2>/dev/null || true
> /home/nanoclaw/.bash_history 2>/dev/null || true

echo "  [7/8] Cleaning local config..."
rm -rf /home/nanoclaw/.config/nanoclaw
rm -rf /root/.config/nanoclaw

echo "  [8/8] Cleaning systemd journal..."
journalctl --rotate 2>/dev/null || true
journalctl --vacuum-time=1s 2>/dev/null || true

echo "  Sanitization complete"
REMOTE_SCRIPT

# ============================================================
# Step 4: Snapshot the clean clone
# ============================================================
echo ""
echo "[4/5] Taking clean snapshot..."

ACTION_JSON=$(doctl compute droplet-action snapshot "$CLONE_ID" --snapshot-name "$SNAPSHOT_NAME" --format ID --no-header)
wait_for_action "$CLONE_ID" "$ACTION_JSON" "clean snapshot"

CLEAN_SNAP_ID=$(doctl compute snapshot list --format Name,ID --no-header | grep "^${SNAPSHOT_NAME} " | awk '{print $2}')
echo "  Clean snapshot ready: $SNAPSHOT_NAME (ID: $CLEAN_SNAP_ID)"

# ============================================================
# Step 5: Cleanup
# ============================================================
echo ""
echo "[5/5] Cleaning up..."

# Destroy the clone
doctl compute droplet delete "$CLONE_ID" --force
echo "  Clone destroyed"

# Delete the temporary (unsanitized) snapshot
doctl compute snapshot delete "$TEMP_SNAP_ID" --force
echo "  Temporary snapshot deleted"

echo ""
echo "=== Done ==="
echo ""
echo "Clean snapshot: $SNAPSHOT_NAME (ID: $CLEAN_SNAP_ID)"
echo ""
echo "To deploy to a client:"
echo "  doctl compute droplet create client-name --image $CLEAN_SNAP_ID --size s-2vcpu-4gb --region nyc1 --ssh-keys <key-id>"
echo ""
echo "Then on the new droplet:"
echo "  1. Fill in $APP_DIR/.env (see .env.template)"
echo "  2. Run: ./container/build.sh"
echo "  3. Run: systemctl start nanoclaw"
echo "  4. Run /setup from Claude Code to link WhatsApp"
