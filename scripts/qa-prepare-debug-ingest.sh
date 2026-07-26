#!/usr/bin/env bash
# Prepare Cursor Debug ingest for `bun run qa:open`:
#   1. Write discovery offer (.cursor/debug-ingest-offer.json)
#   2. Start offer sidecar (:7663) + socat relay (plugin → Cursor localhost)
#   3. Write qa-debug-bootstrap.json into the vault plugin folder
#
# Cursor itself must already be in a Debug session (scripts cannot start the listener).
#
# Env (required unless an offer file already exists with matching values):
#   CURSOR_DEBUG_SESSION       — session slug (X-Debug-Session-Id)
#   CURSOR_DEBUG_INGEST_PATH   — e.g. /ingest/<uuid>
#   CURSOR_DEBUG_PORT          — port Cursor bound for ingest (e.g. 7557)
#
# Optional:
#   SYNC_TESTER_VAULT          — vault root (default: qa-test-vault)
#   INGEST_RELAY_PORT          — port advertised to the plugin (default: 7662)
#   QA_SKIP_INGEST=1           — skip offer/relay; still write verbose bootstrap
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VAULT="${SYNC_TESTER_VAULT:-$ROOT/qa-test-vault}"
PLUGIN_DIR="${VAULT}/.obsidian/plugins/dropbox-sync"
OFFER_PATH="${DEBUG_INGEST_OFFER_PATH:-$ROOT/.cursor/debug-ingest-offer.json}"
RELAY_LISTEN="${INGEST_RELAY_PORT:-7662}"
OFFER_PORT="${DEBUG_INGEST_OFFER_PORT:-7663}"
PID_FILE="${ROOT}/.cursor/qa-ingest-relay.pid"
LOG_FILE="${ROOT}/.cursor/qa-ingest-relay.log"

mkdir -p "${PLUGIN_DIR}" "${ROOT}/.cursor"

write_bootstrap() {
  # Always enable debug + verbose for QA so the agent can watch decision logs.
  cat > "${PLUGIN_DIR}/qa-debug-bootstrap.json" <<'EOF'
{
  "debugLoggingEnabled": true,
  "verboseDecisionLogging": true,
  "autoConnectIngest": true
}
EOF
  echo "==> wrote ${PLUGIN_DIR}/qa-debug-bootstrap.json (debug + verbose on)"
}

# Merge debugLoggingEnabled into data.json without wiping OAuth / other settings.
patch_data_json_debug() {
  python3 - "$PLUGIN_DIR/data.json" <<'PY'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
data = {}
if path.is_file():
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        data = {}
if not isinstance(data, dict):
    data = {}
data["debugLoggingEnabled"] = True
data.setdefault("onboardingDone", True)
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
print(f"==> data.json debugLoggingEnabled=true ({path})")
PY
}

write_bootstrap
patch_data_json_debug

if [[ "${QA_SKIP_INGEST:-}" == "1" ]]; then
  echo "==> QA_SKIP_INGEST=1 — bootstrap only (no offer/relay)"
  exit 0
fi

SESSION_ID="${CURSOR_DEBUG_SESSION:-}"
INGEST_PATH="${CURSOR_DEBUG_INGEST_PATH:-}"
CURSOR_PORT="${CURSOR_DEBUG_PORT:-}"

# Reuse an existing offer when env is incomplete (agent may have written it already).
if [[ -z "${SESSION_ID}" || -z "${INGEST_PATH}" || -z "${CURSOR_PORT}" ]]; then
  if [[ -f "${OFFER_PATH}" ]]; then
    eval "$(python3 - "$OFFER_PATH" <<'PY'
import json, shlex, sys
from pathlib import Path
o = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
print("SESSION_ID=" + shlex.quote(str(o.get("sessionId") or "")))
print("INGEST_PATH=" + shlex.quote(str(o.get("ingestPath") or "")))
# Prefer dedicated cursor port env; offer.port is what the plugin uses (relay listen).
print("OFFER_PORT_FROM_FILE=" + shlex.quote(str(o.get("port") or "")))
PY
)"
    if [[ -z "${CURSOR_PORT}" && -n "${INGEST_RELAY_TARGET_PORT:-}" ]]; then
      CURSOR_PORT="${INGEST_RELAY_TARGET_PORT}"
    fi
  fi
fi

if [[ -z "${SESSION_ID}" || -z "${INGEST_PATH}" ]]; then
  cat <<EOF >&2
ERROR: Cursor Debug session info missing.

Start (or switch to) a Cursor Debug agent session, then re-run with:

  CURSOR_DEBUG_SESSION=<slug> \\
  CURSOR_DEBUG_INGEST_PATH=/ingest/<uuid> \\
  CURSOR_DEBUG_PORT=<cursor-ingest-port> \\
  bun run qa:open

Or run /debug-ingest first so ${OFFER_PATH} exists.
EOF
  exit 1
fi

if [[ -z "${CURSOR_PORT}" ]]; then
  # Desktop-only fallback: plugin posts to the same port as the offer (direct).
  CURSOR_PORT="${RELAY_LISTEN}"
  echo "WARN: CURSOR_DEBUG_PORT unset — using ${CURSOR_PORT} as Cursor target" >&2
fi

echo "==> write debug ingest offer (plugin → :${RELAY_LISTEN} → Cursor :${CURSOR_PORT})"
bash "${ROOT}/scripts/write-debug-ingest-offer.sh" \
  --session "${SESSION_ID}" \
  --path "${INGEST_PATH}" \
  --port "${RELAY_LISTEN}" \
  --host 127.0.0.1 \
  --offer-path "${OFFER_PATH}"

# Restart relay if already running from a prior qa:open.
if [[ -f "${PID_FILE}" ]]; then
  OLD_PID="$(cat "${PID_FILE}" 2>/dev/null || true)"
  if [[ -n "${OLD_PID}" ]] && kill -0 "${OLD_PID}" 2>/dev/null; then
    echo "==> stopping prior ingest relay (pid ${OLD_PID})"
    kill "${OLD_PID}" 2>/dev/null || true
    wait "${OLD_PID}" 2>/dev/null || true
  fi
  rm -f "${PID_FILE}"
fi

echo "==> start ingest relay + offer sidecar (log: ${LOG_FILE})"
# Relay listen port is what auto-connect uses; target is Cursor's bind port.
INGEST_RELAY_PORT="${RELAY_LISTEN}" \
INGEST_RELAY_TARGET_HOST="127.0.0.1" \
INGEST_RELAY_TARGET_PORT="${CURSOR_PORT}" \
DEBUG_INGEST_OFFER_PATH="${OFFER_PATH}" \
DEBUG_INGEST_OFFER_PORT="${OFFER_PORT}" \
  bash "${ROOT}/scripts/ingest-lan-relay.sh" >"${LOG_FILE}" 2>&1 &
echo $! > "${PID_FILE}"
sleep 0.4
if ! kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
  echo "ERROR: ingest relay failed to start. See ${LOG_FILE}" >&2
  tail -n 30 "${LOG_FILE}" >&2 || true
  exit 1
fi

echo "==> ingest ready"
echo "    offer:  http://127.0.0.1:${OFFER_PORT}/offer"
echo "    relay:  127.0.0.1:${RELAY_LISTEN} → 127.0.0.1:${CURSOR_PORT}"
echo "    session: ${SESSION_ID}"
echo "    path:    ${INGEST_PATH}"
echo "    log file: .cursor/debug-${SESSION_ID}.log (Cursor Debug)"
