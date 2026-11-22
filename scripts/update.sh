#!/usr/bin/env bash
# Met à jour le serveur depuis GitHub puis le redémarre.
# À lancer en root (ou avec un utilisateur ayant sudo).
set -euo pipefail
cd "$(dirname "$0")/.."
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
OWNER=$(stat -c %U . 2>/dev/null || echo root)
$SUDO git config --global --add safe.directory "$PWD" 2>/dev/null || true
$SUDO git pull --ff-only
$SUDO npm ci --omit=dev --no-audit --no-fund
$SUDO chown -R "$OWNER:$OWNER" .
$SUDO systemctl restart foundry-mcp
echo "Mis à jour : $(git log -1 --format='%h %s')"
