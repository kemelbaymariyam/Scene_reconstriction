#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VIEWER="$ROOT/viewer"
PORT="${1:-5173}"

cd "$VIEWER"
if [[ ! -d node_modules ]]; then
  if [[ -f package-lock.json ]]; then npm ci; else npm install; fi
fi

npm run dev -- --host 127.0.0.1 --port "$PORT"
