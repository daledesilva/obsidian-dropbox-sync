# Debug ready vault

Wipe + reseed the in-repo QA vault with `_seeds/` fixtures, wire Cursor Debug ingest to **this** Debug session, and open sandboxed Obsidian.

Invoke as `/debug-ready-vault`. Optional text after the command is context (e.g. runbook id, iPad).

## Preconditions

- This chat **must** be a **Cursor Debug** agent session (HTTP ingest listener already running). Scripts cannot start the listener.
- If this is not Debug mode, stop and tell the user to start a Debug Mode chat, then re-run `/debug-ready-vault`.

## Goal

One shot: matching ingest offer + relay for **this** session → `bun run qa:restart` (local wipe + seed fixtures + Obsidian). Do **not** ask the user to export `CURSOR_DEBUG_*` by hand.

## Steps

1. **Read Debug session values** from this chat’s system/debug context (required):
   - `CURSOR_DEBUG_SESSION` — session slug (e.g. `b28b28`)
   - `CURSOR_DEBUG_INGEST_PATH` — `/ingest/<uuid>` (path UUID ≠ session slug)
   - `CURSOR_DEBUG_PORT` — port Cursor bound on localhost (e.g. `7557`)
   - Log file — `.cursor/debug-<sessionId>.log`

2. **Stop stale relays** if needed (ports **7662** / **7663**, or `.cursor/qa-ingest-relay.pid`), so prepare can bind cleanly.

3. **Run ready vault + ingest** from the repo root (background — `obsidian-launcher` stays open):

   ```bash
   CURSOR_DEBUG_SESSION=<sessionId> \
   CURSOR_DEBUG_INGEST_PATH=<ingestPath> \
   CURSOR_DEBUG_PORT=<cursorPort> \
   bun run qa:restart
   ```

   That calls `qa-prepare-debug-ingest.sh` (offer + `7662 →` Cursor port + bootstrap) then opens the vault. Never run bare `qa:restart` without these three env vars.

4. **Verify ingest** after Obsidian is up:
   - Confirm offer/relay: session matches this chat; relay is `7662 → <CURSOR_DEBUG_PORT>`.
   - Clear **only** `.cursor/debug-<sessionId>.log` for this session (delete_file; do not wipe other `debug-*.log` files).
   - Ask the user: Debug logging on → Connected (auto on Mac; **Connect** on iPad) → **Send test log**.
   - Confirm the canary appears in `.cursor/debug-<sessionId>.log`.

5. **Hand off** briefly:
   - Vault is wiped locally and reseeded with `_seeds/` + runbooks.
   - Dropbox remote was **not** wiped — clear it in Dropbox web if they need a clean peer.
   - Point them at `_runbooks/INDEX.md` (or the runbook they named).

## Do not

- Skip Debug-mode check or invent session/path/port.
- Reuse a stale `.cursor/debug-ingest-offer.json` from a prior session without rewriting via prepare with **this** session’s env.
- Use `fetch('http://127.0.0.1:…')` inside the plugin — ingest stays on `requestUrl` / `main.log()`.
- Document unless the user asks (`/document`).

See `scripts/qa-restart.sh`, `scripts/qa-prepare-debug-ingest.sh`, `/debug-ingest`, and `.cursor/rules/cursor-debug-ingest.mdc`.
