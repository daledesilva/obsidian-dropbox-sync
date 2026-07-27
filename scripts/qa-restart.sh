#!/usr/bin/env bash
# Hard-reset the QA vault (erase local vault including auth/sync state), then
# regenerate *with* `_seeds/` fixtures and open like qa:open.
#
# For an empty vault (no test fixtures) use `bun run qa:empty` instead.
#
# Does NOT wipe the linked Dropbox folder — clear that in Dropbox if you need a
# clean remote peer.
#
# Usage:
#   bun run qa:restart
#   QA_SKIP_INGEST=1 bun run qa:restart
#   Same CURSOR_DEBUG_* env as qa:open when using ingest.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export QA_WIPE=1
echo "==> qa:restart (wipe vault + reseed fixtures + open)"
exec bash "${ROOT}/scripts/qa-open.sh"
