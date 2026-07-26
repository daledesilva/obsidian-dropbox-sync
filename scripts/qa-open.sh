#!/usr/bin/env bash
# Build the plugin, generate the QA vault, prepare Cursor Debug ingest, and open
# sandboxed Obsidian via obsidian-launcher (same pattern as obsidian_ink).
#
# Debug ingest: writes offer + starts LAN relay/sidecar, seeds
# qa-debug-bootstrap.json (Debug logging + verbose decision logging). On load the
# plugin auto-connects to 127.0.0.1 so the agent can watch `.cursor/debug-*.log`.
#
# Cursor must already be in a Debug session (scripts cannot start the listener).
#
# Usage (from repo root):
#   CURSOR_DEBUG_SESSION=<slug> \
#   CURSOR_DEBUG_INGEST_PATH=/ingest/<uuid> \
#   CURSOR_DEBUG_PORT=<port> \
#   bun run qa:open
#
#   bun run open-qa
#   QA_SKIP_INGEST=1 bun run qa:open    # vault only (no offer/relay)
#   QA_COPY=1 bun run qa:open
#
# Env:
#   SYNC_TESTER_VAULT     — vault root (default: qa-test-vault in the repo)
#   CURSOR_DEBUG_*        — required for ingest unless offer file already exists
#   QA_SKIP_INGEST=1      — skip offer/relay; still enable debug+verbose bootstrap
#   QA_COPY=1             — pass --copy (session edits discarded; re-OAuth each time)
#   QA_OBSIDIAN_VERSION   — Obsidian app version (default: latest)
#   QA_WATCH=0            — use `launch` instead of `watch`
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VAULT="${SYNC_TESTER_VAULT:-$ROOT/qa-test-vault}"
APP_VERSION="${QA_OBSIDIAN_VERSION:-latest}"
USE_WATCH="${QA_WATCH:-1}"

echo "==> build"
bun run build

# Fresh log surface for this QA open/restart (vault sync logs + Cursor Debug NDJSON).
echo "==> clear QA / debug logs"
rm -f "${VAULT}"/sync-debug-*.log
rm -rf "${VAULT}/sync-logs"
mkdir -p "${VAULT}/sync-logs"
rm -f "${ROOT}"/.cursor/debug-*.log

if [[ "${QA_WIPE:-}" == "1" ]]; then
  echo "==> qa:generate --wipe → $VAULT (full local erase)"
  SYNC_TESTER_VAULT="$VAULT" QA_WIPE=1 bun run qa:wipe
else
  echo "==> qa:generate → $VAULT"
  SYNC_TESTER_VAULT="$VAULT" bun run qa:generate
fi

echo "==> prepare debug ingest + QA bootstrap"
SYNC_TESTER_VAULT="$VAULT" bash "${ROOT}/scripts/qa-prepare-debug-ingest.sh"

LAUNCHER_ARGS=(--version "$APP_VERSION" --plugin ./dist)
if [[ "${QA_COPY:-}" == "1" ]]; then
  echo "==> QA_COPY=1 — opening a disposable vault copy (auth will not persist)"
  LAUNCHER_ARGS+=(--copy)
fi

echo "==> obsidian-launcher (sandboxed Obsidian)"
echo "    Expect: Debug logging on, verbose decisions on, ingest Connected (localhost)."
if [[ "$USE_WATCH" == "0" ]]; then
  npx obsidian-launcher launch "${LAUNCHER_ARGS[@]}" "$VAULT"
else
  # watch installs hot-reload and reloads the plugin when dist/ changes
  npx obsidian-launcher watch "${LAUNCHER_ARGS[@]}" "$VAULT"
fi
