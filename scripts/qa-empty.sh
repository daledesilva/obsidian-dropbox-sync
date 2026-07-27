#!/usr/bin/env bash
# Fresh-join QA: wipe local vault and open an *empty* vault with the plugin.
#
# Unlike qa:restart (which reseeds `_seeds/` fixtures), this leaves no test
# notes/folders — only runbooks + Obsidian config + Dropbox Sync. Use for
# runbook 10 (Joining or rejoining).
#
# Does NOT wipe the linked Dropbox folder. Clear that in Dropbox web when you
# need an empty remote peer.
#
# Usage:
#   bun run qa:empty
#   QA_SKIP_INGEST=1 bun run qa:empty
#   Same CURSOR_DEBUG_* env as qa:open when using ingest.
#
# Optional:
#   QA_WITH_SEEDS=1  — also regenerate `_seeds/` (upload-ask against empty remote)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VAULT="${SYNC_TESTER_VAULT:-$ROOT/qa-test-vault}"

echo "==> qa:empty (empty local vault for runbook 10)"
echo ""
echo "    Local wipe:   auth, sync state, and vault files under:"
echo "                  $VAULT"
echo "    Vault shape:  empty of test fixtures (no _seeds/ notes) — not qa:restart"
echo "    Plugin:       built into dist/ and loaded by obsidian-launcher"
echo "    Remote:       NOT wiped — clear the Dropbox app folder in the web UI"
echo "                  if you need an empty peer for first sync."
if [[ "${QA_WITH_SEEDS:-}" == "1" ]]; then
  echo "    Seeds:        WITH_SEEDS=1 — regenerating fixtures for upload-ask checks"
  unset QA_EMPTY_SEEDS || true
else
  echo "    Seeds:        none (default). QA_WITH_SEEDS=1 adds fixtures if needed."
  export QA_EMPTY_SEEDS=1
fi
echo ""
echo "    After Obsidian opens:"
echo "      1. Enable Dropbox Sync if needed; complete OAuth."
echo "      2. Open _runbooks/10-joining-or-rejoining.md"
echo "      3. Sync Now — expect download of remote files when the peer has content."
echo ""

export QA_WIPE=1
exec bash "${ROOT}/scripts/qa-open.sh"
