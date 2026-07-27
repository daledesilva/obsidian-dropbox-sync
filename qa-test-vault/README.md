# Sync QA Test Vault

Regenerable Dropbox sync playground for **manual integration** checks on branch `release_0.2`. Automated correctness stays in `bun test` (planner, guards, `test/simulation/`). This vault is for real Dropbox + sandboxed Obsidian + debug-ingest log capture.

There is **no** automated Obsidian↔Dropbox e2e. OAuth stays a one-time human step.

## Quick start

```bash
# From repo root — build, generate into qa-test-vault/, open sandboxed Obsidian
bun run qa:open
# alias: bun run open-qa
```

Uses [`obsidian-launcher`](https://www.npmjs.com/package/obsidian-launcher) (same pattern as `obsidian_ink` / `obsidian_project-browser`): isolated Obsidian config, installs `./dist` as the plugin, and `watch` mode adds Hot Reload when `dist/` changes.

Also prepares **Cursor Debug ingest**: writes the discovery offer, starts the LAN relay + offer sidecar, and seeds `qa-debug-bootstrap.json` so Debug logging + verbose decision logging are on and localhost auto-connect runs on open. Requires an active Cursor Debug session:

```bash
CURSOR_DEBUG_SESSION=<slug> \
CURSOR_DEBUG_INGEST_PATH=/ingest/<uuid> \
CURSOR_DEBUG_PORT=<port> \
bun run qa:open
```

Use `QA_SKIP_INGEST=1` to open the vault without offer/relay. **No `--copy` by default** — Dropbox OAuth and plugin `data.json` must persist. Disposable copy: `QA_COPY=1 bun run qa:open`.

Or step by step:

```bash
bun run qa:generate    # write seeds + runbooks into qa-test-vault/
bun run build          # plugin → dist/
npx obsidian-launcher watch --plugin ./dist qa-test-vault
```

1. Enable **Dropbox Sync** if needed. OAuth once.
2. Sync Now once so `_seeds/` baselines onto Dropbox.
3. Open `_runbooks/INDEX.md` and pick a scenario.

### System Obsidian / external vault

```bash
SYNC_TESTER_VAULT=~/Documents/sync-tester bun run qa:generate
bun run qa:deploy      # copy dist into that vault’s dropbox-sync plugin folder
# then open that folder in your normal Obsidian
```

## Reset vs restart vs join

```bash
bun run qa:reset       # reseed _seeds/_runbooks only — keeps auth + sync state
bun run qa:restart     # ERASE local vault, recreate *with* _seeds/ fixtures, open
bun run qa:empty        # ERASE local vault, recreate *empty* (no fixtures), open — runbook 10
bun run qa:wipe        # erase + regenerate only (no Obsidian launch)
```

**Local wipe ≠ remote wipe.** `qa:restart` / `qa:empty` / `qa:wipe` clear the local vault only. Clear the linked Dropbox folder in Dropbox web if you need a clean remote peer.

For **runbook 10 (Joining or rejoining)**, use `bun run qa:empty` (empty vault). Use `qa:restart` when you need the seeded playground again.

## Live protocol (you + agent)

1. You: `bun run qa:open` (or `qa:generate` if Obsidian is already open on this vault).
2. Agent: start debug ingest (`/debug-ingest`).
3. You: Settings → Troubleshooting → enable **Debug logging** → confirm Connected → **Send test log**.
4. You: follow one runbook; Sync Now / live sync as instructed.
5. Agent: read `.cursor/debug-<sessionId>.log` and compare to the runbook’s expected outcome / log signals.
6. After a dirty scenario: wipe remote folder if needed, then `bun run qa:reset`.

## Layout (generated)

```
qa-test-vault/          # also the vault root (default)
  START_HERE.md         # vault landing note (tooling README.md stays tracked)
  _runbooks/            # human scripts (01–13 + INDEX)
  _seeds/               # baseline notes, case, folders, binaries, bulk, exclude-bait
  .obsidian/
    app.json
    community-plugins.json
    plugins/dropbox-sync/   # from obsidian-launcher --plugin ./dist
  generate.mjs          # tracked
  templates/            # tracked
```

## Source of truth for scenarios

Runbooks cite sections of [`docs/sync-scenarios.md`](../docs/sync-scenarios.md). Simulation coverage for those rows is tracked in [`SIMULATION_COVERAGE.md`](./SIMULATION_COVERAGE.md). How the matrix, simulator, and this vault fit together: [`docs/sync-scenario-testing.md`](../docs/sync-scenario-testing.md).

## Future

A second vault / iPad device for true two-plugin multi-writer rows is out of scope for this harness. Use Dropbox web as the peer for multi-device steps when needed.
