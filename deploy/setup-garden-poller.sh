#!/bin/bash
# Garden Poller Setup — run this on the VPS (as root or with sudo)
# Copies garden-poller.js, systemd service, and starts it.
#
# Usage:
#   sudo bash setup-garden-poller.sh
#
# Or from local dev machine (after SCPing files):
#   scp -i ~/.ssh/id_ed25519_aliyun bin/garden-poller.js deploy/garden-poller.service yanqi@8.163.18.138:/tmp/
#   ssh -i ~/.ssh/id_ed25519_aliyun yanqi@8.163.18.138 "sudo bash /tmp/setup-garden-poller.sh"

set -e

PROJECT_DIR="/opt/cyberboss"
BIN_DIR="$PROJECT_DIR/bin"
DEPLOY_DIR="$PROJECT_DIR/deploy"
STATE_DIR="/root/.cyberboss"

echo "=== Garden Poller Setup ==="

# 1. Copy files
echo "[1/4] Copying garden-poller.js..."
mkdir -p "$BIN_DIR"
mkdir -p "$DEPLOY_DIR"

# Check if script was placed in /tmp by scp
if [ -f /tmp/garden-poller.js ]; then
  cp /tmp/garden-poller.js "$BIN_DIR/garden-poller.js"
  echo "  -> copied from /tmp/garden-poller.js"
elif [ -f "$BIN_DIR/garden-poller.js" ]; then
  echo "  -> already in place"
else
  echo "  ERROR: garden-poller.js not found. scp it to /tmp/ first."
  exit 1
fi

if [ -f /tmp/garden-poller.service ]; then
  cp /tmp/garden-poller.service /etc/systemd/system/garden-poller.service
  echo "  -> service file installed"
elif [ -f "$DEPLOY_DIR/garden-poller.service" ]; then
  cp "$DEPLOY_DIR/garden-poller.service" /etc/systemd/system/garden-poller.service
  echo "  -> service file installed from $DEPLOY_DIR"
else
  echo "  ERROR: garden-poller.service not found."
  exit 1
fi

# 2. Make executable
chmod +x "$BIN_DIR/garden-poller.js"
echo "[2/4] garden-poller.js is executable"

# 3. Test run (dry-run: initialize MCP, check connectivity)
echo "[3/4] Testing garden connectivity..."
timeout 15 node "$BIN_DIR/garden-poller.js" &
PID=$!
sleep 5
if kill -0 $PID 2>/dev/null; then
  echo "  -> OK: poller started and running"
  kill $PID 2>/dev/null || true
else
  echo "  -> WARNING: poller exited early, check logs"
fi

# 4. Enable and start service
echo "[4/4] Enabling systemd service..."
systemctl daemon-reload
systemctl enable garden-poller
systemctl restart garden-poller
sleep 2
systemctl status garden-poller --no-pager -l | head -15

echo ""
echo "=== Done ==="
echo "Commands:"
echo "  systemctl status garden-poller   # check status"
echo "  journalctl -u garden-poller -f   # follow logs"
echo "  systemctl restart garden-poller  # restart"
echo "  systemctl stop garden-poller     # stop"
