#!/usr/bin/env bash
# Update the server from GitHub, then restart it.
# Run as root (or a user with sudo privileges).
set -euo pipefail
cd "$(dirname "$0")/.."
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
OWNER=$(stat -c %U . 2>/dev/null || echo root)
$SUDO git config --global --add safe.directory "$PWD" 2>/dev/null || true
$SUDO git pull --ff-only
$SUDO npm ci --omit=dev --no-audit --no-fund
$SUDO chown -R "$OWNER:$OWNER" .
$SUDO systemctl restart foundry-mcp
echo "Updated: $(git log -1 --format='%h %s')"
