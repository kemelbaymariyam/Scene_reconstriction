#!/usr/bin/env bash
set -euo pipefail

CONFIG="${1:-}"
OUTPUT="${2:-exports/splat}"

if [[ -z "$CONFIG" ]]; then
  echo "Usage: bash scripts/export_splat.sh path/to/config.yml [output-dir]" >&2
  exit 2
fi

ns-export gaussian-splat \
  --load-config "$CONFIG" \
  --output-dir "$OUTPUT"

echo "Export written to $OUTPUT"
