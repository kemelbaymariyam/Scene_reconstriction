#!/usr/bin/env bash
set -euo pipefail

DATA="${1:-prepared}"

if ! command -v ns-train >/dev/null 2>&1; then
  echo "ns-train is not available. Activate the DN-Splatter environment." >&2
  exit 1
fi

ns-train dn-splatter \
  --experiment-name infrascan \
  --output-dir outputs \
  --max-num-iterations 30000 \
  --pipeline.model.use-depth-loss True \
  --pipeline.model.depth-loss-type PearsonDepth \
  --pipeline.model.depth-lambda 0.2 \
  --pipeline.model.use-normal-loss True \
  --pipeline.model.use-normal-tv-loss True \
  --pipeline.model.normal-supervision depth \
  --pipeline.model.camera-optimizer.mode off \
  normal-nerfstudio \
  --data "$DATA" \
  --orientation-method none \
  --center-method none \
  --auto-scale-poses False \
  --depth-unit-scale-factor 0.001 \
  --eval-mode interval \
  --eval-interval 12
