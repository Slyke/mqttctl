#!/usr/bin/env bash
set -euo pipefail

cd /workspace/mqttctl

# The dev container mounts node_modules on a named volume. Refresh workspace
# dependencies on startup so newly added packages are available without
# requiring the operator to manually clear that volume.
npm install --no-fund --no-audit

exec npm run dev --workspace mqttctl-fe -- --host "${HOST:-0.0.0.0}" --port "${PORT:-3000}"
