#!/usr/bin/env bash
# Print values to paste into Obsidian → Settings → Dropbox Sync → Troubleshooting
# → Cursor Debug ingest (device-local fields).
#
# Session ID and ingest path still come from the active Cursor Debug session
# context (agent system reminder / Debug panel) — this script only covers host/port.
#
# Usage:
#   bash scripts/print-debug-ingest-settings.sh
#
# See docs/cursor-debug-ingest.md

set -euo pipefail

LISTEN_PORT="${INGEST_RELAY_PORT:-7662}"
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"

echo "=== Cursor Debug ingest — plugin settings ==="
echo ""
if [[ -n "${LAN_IP}" ]]; then
	echo "Host:  ${LAN_IP}"
else
	echo "Host:  (could not detect — check System Settings → Network / Wi‑Fi IP)"
fi
echo "Port:  ${LISTEN_PORT}"
echo ""
echo "Also set from the active Cursor Debug session:"
echo "  Session ID:   short slug (e.g. e7cde3) → .cursor/debug-<slug>.log"
echo "  Ingest path:  /ingest/<uuid>  (NOT the same as the session slug)"
echo ""
echo "Then on the Mac (Debug session must already be running):"
echo "  bash scripts/ingest-lan-relay.sh"
echo ""
echo "In Obsidian: enable Debug logging → Send test log."
