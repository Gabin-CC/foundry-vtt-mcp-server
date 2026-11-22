#!/usr/bin/env bash
# Met à jour le serveur depuis GitHub puis le redémarre.
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
npm ci --omit=dev --no-audit --no-fund
sudo systemctl restart foundry-mcp
echo "Mis à jour : $(git log -1 --format='%h %s')"
