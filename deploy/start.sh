#!/usr/bin/env bash
# AgentTether backend launcher for daemon supervisors (launchd / systemd).
#
# Supervisors run with a minimal PATH and no shell rc, so nvm's node isn't on it —
# this wrapper resolves node in the usual places and execs tsx directly (fewer process
# layers than `npm start`, and signals reach the backend itself).
#
# Override the node binary with NODE_BIN if node lives elsewhere:
#   NODE_BIN=/usr/local/bin/node ./deploy/start.sh
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -z "${NODE_BIN:-}" ]; then
  for candidate in \
    "$HOME/.nvm/versions/node/v25.9.0/bin/node" \
    /usr/local/bin/node \
    /opt/homebrew/bin/node; do
    if [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
  done
fi
if [ -z "${NODE_BIN:-}" ]; then
  echo "no node binary found — set NODE_BIN" >&2
  exit 1
fi

exec "$NODE_BIN" node_modules/tsx/dist/cli.mjs src/index.ts
