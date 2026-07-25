# Debug ingest (Wi‑Fi / Cursor Debug)

Set up live NDJSON ingest from the Obsidian plugin (desktop or mobile) into Cursor’s Debug log file so the agent can watch runtime evidence.

Any text after `/debug-ingest` is optional context (e.g. iPad, session id).

## Preconditions

- User should be in (or about to start) a **Cursor Debug** agent session — shell scripts **cannot** start the ingest listener.
- Note from Debug session context: **session ID** (slug), **ingest path** (`/ingest/<uuid>`), **log file** (`.cursor/debug-<sessionId>.log`). Path UUID ≠ session slug.

## Steps

1. **Confirm Debug ingest is live**
   - If this is not a Debug-mode session, tell the user to start one (or switch) before continuing.
   - Record session id, ingest path, and log file path from the system/debug context.

2. **Start LAN relay** (required for mobile / other devices; optional on same-machine desktop using `127.0.0.1`):
   ```bash
   bash scripts/ingest-lan-relay.sh
   ```
   Run in the background if needed. Requires `socat` (`brew install socat`).
   Print host values with:
   ```bash
   bash scripts/print-debug-ingest-settings.sh
   ```

3. **Configure the plugin** (Settings → Dropbox Sync → Troubleshooting):
   - Enable **Debug logging**
   - Set device-local **Host** (Mac LAN IP on mobile; empty → `127.0.0.1` on desktop), **Port**, **Session ID**, **Ingest path**
   - Tap **Send test log**

4. **Clear only the session log** before reproduction:
   - Truncate/delete **only** `.cursor/debug-<sessionId>.log` for this session (do not wipe unrelated debug logs).

5. **Deploy if instrumented / uncommitted**
   - Local `dist/` copy includes working-tree code; CI/release builds do not.
   - Desktop test vault: `bun run build && cp dist/* ~/Documents/sync-tester/.obsidian/plugins/dropbox-sync/`
   - iPad: copy built plugin into the vault’s `.obsidian/plugins/dropbox-sync/` (manual).

6. **Reproduce**, then **read** `.cursor/debug-<sessionId>.log` and cite line evidence before fixing.

7. After a verified fix, remove temporary ad-hoc ingest call sites. Keep `src/debug/cursor-debug-ingest.ts` and the gated `main.log()` path.

## Do not

- Use `fetch('http://127.0.0.1:…')` inside the plugin — use `requestUrl` via `postCursorDebugIngest` / `main.log()`.
- Assume USB alone bridges iOS to localhost (use Wi‑Fi + relay).
- Treat silent ingest failure as proof a code path did not run — verify with **Send test log** and the session log file.

See `docs/cursor-debug-ingest.md` and `.cursor/rules/cursor-debug-ingest.mdc`.
