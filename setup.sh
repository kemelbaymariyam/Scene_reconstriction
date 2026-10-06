#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VIEWER="$ROOT/viewer"

command -v node >/dev/null 2>&1 || { echo "Node.js was not found."; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm was not found."; exit 1; }
[[ -f "$VIEWER/package.json" ]] || { echo "viewer/package.json was not found."; exit 1; }

node "$ROOT/verify_assets.mjs"

cd "$VIEWER"
if [[ -f package-lock.json ]]; then npm ci; else npm install; fi

echo "Setup complete. Run ./start_viewer.sh"
