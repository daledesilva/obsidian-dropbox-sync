# Debug empty vault

Wipe the in-repo QA vault **without** `_seeds/` fixtures (join / rejoin shape), wire Cursor Debug ingest to **this** Debug session, and open sandboxed Obsidian.

Invoke as `/debug-empty-vault`. Optional text after the command is context (e.g. runbook 10, iPad).

## Preconditions

- This chat **must** be a **Cursor Debug** agent session (HTTP ingest listener already running). Scripts cannot start the listener.
- If this is not Debug mode, stop and tell the user to start a Debug Mode chat, then re-run `/debug-empty-vault`.

## Goal

One shot: matching ingest offer + relay for **this** session → `bun run qa:empty` (local wipe, empty of test fixtures, plugin + runbooks only). Do **not** ask the user to export `CURSOR_DEBUG_*` by hand.

## Steps

1. **Read Debug session values** from this chat’s system/debug context (required):
   - `CURSOR_DEBUG_SESSION` — session slug (e.g. `b28b28`)
   - `CURSOR_DEBUG_INGEST_PATH` — `/ingest/<uuid>` (path UUID ≠ session slug)
   - `CURSOR_DEBUG_PORT` — port Cursor bound on localhost (e.g. `7557`)
   - Log file — `.cursor/debug-<sessionId>.log`

2. **Stop stale relays** if needed (ports **7662** / **7663**, or `.cursor/qa-ingest-relay.pid`), so prepare can bind cleanly.

3. **Run empty vault + ingest** from the repo root (background — `obsidian-launcher` stays open):

   ```bash
   CURSOR_DEBUG_SESSION=<sessionId> \
   CURSOR_DEBUG_INGEST_PATH=<ingestPath> \
   CURSOR_DEBUG_PORT=<cursorPort> \
   bun run qa:empty
   ```

   That calls `qa-prepare-debug-ingest.sh` (offer + `7662 →` Cursor port + bootstrap) then opens the vault. Never run bare `qa:empty` without these three env vars.

   Only if the user explicitly asked for seeds on an empty join: `QA_WITH_SEEDS=1 bun run qa:empty` (same `CURSOR_DEBUG_*`).

4. **Verify ingest** after Obsidian is up:
   - Confirm offer/relay: session matches this chat; relay is `7662 → <CURSOR_DEBUG_PORT>`.
   - Clear **only** `.cursor/debug-<sessionId>.log` for this session (delete_file; do not wipe other `debug-*.log` files).
   - Ask the user: Debug logging on → Connected (auto on Mac; **Connect** on iPad) → **Send test log**.
   - Confirm the canary appears in `.cursor/debug-<sessionId>.log`.

5. **Hand off** briefly:
   - Local vault is empty of test fixtures (no `_seeds/` notes) — use for **runbook 10** (joining / rejoining), not seeded playground scenarios.
   - Dropbox remote was **not** wiped — clear the linked folder in Dropbox web if they need an empty peer.
   - Point them at `_runbooks/10-joining-or-rejoining.md` (or the runbook they named).

## Do not

- Skip Debug-mode check or invent session/path/port.
- Reuse a stale `.cursor/debug-ingest-offer.json` from a prior session without rewriting via prepare with **this** session’s env.
- Confuse with `/debug-ready-vault` (`qa:restart` reseeds `_seeds/`; this command does not).
- Use `fetch('http://127.0.0.1:…')` inside the plugin — ingest stays on `requestUrl` / `main.log()`.
- Document unless the user asks (`/document`).

See `scripts/qa-empty.sh`, `scripts/qa-prepare-debug-ingest.sh`, `/debug-ingest`, and `.cursor/rules/cursor-debug-ingest.mdc`.
