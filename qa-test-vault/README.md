# Sync QA Test Vault

Regenerable Dropbox sync playground for **manual integration** checks on branch `release_0.2`. Automated correctness stays in `bun test` (planner, guards, `test/simulation/`). This vault is for real Dropbox + Obsidian + debug-ingest log capture.

There is **no** automated Obsidian↔Dropbox e2e. OAuth stays a one-time human step.

## Quick start

```bash
# From repo root (release_0.2)
bun run qa:generate    # write seeds + runbooks into ~/Documents/sync-tester
bun run qa:deploy      # build plugin and copy into the vault
```

1. Open `~/Documents/sync-tester` as an Obsidian vault (Open folder as vault).
2. Enable **Dropbox Sync** (and **Hot Reload** if installed). OAuth once if needed.
3. Sync Now once so `_seeds/` baselines onto Dropbox.
4. Open `_runbooks/INDEX.md` and pick a scenario.

Override the target path with `SYNC_TESTER_VAULT=/path/to/vault bun run qa:generate`.

## Reset

```bash
bun run qa:reset       # same as qa:generate — reseeds local content, keeps plugin auth
```

**Local reset ≠ remote wipe.** Scenarios that delete, conflict, or change casing leave Dropbox dirty. Before reseeding those runbooks, clear the linked Dropbox folder in Dropbox web (or the desktop client) so ghost remotes do not fight the new seeds. The generator **never** deletes `.obsidian/plugins/dropbox-sync/data.json` or built plugin files.

## Live protocol (you + agent)

1. You: `bun run qa:generate` (and `qa:deploy` if the plugin changed).
2. Agent: start debug ingest (`/debug-ingest`).
3. You: Settings → Troubleshooting → enable **Debug logging** → confirm Connected → **Send test log**.
4. You: follow one runbook; Sync Now / live sync as instructed.
5. Agent: read `.cursor/debug-<sessionId>.log` and compare to the runbook’s expected outcome / log signals.
6. After a dirty scenario: wipe remote folder if needed, then `bun run qa:reset`.

## Layout (generated)

```
~/Documents/sync-tester/
  README.md
  _runbooks/          # human scripts (01–13 + INDEX)
  _seeds/             # baseline notes, case, folders, binaries, bulk, exclude-bait
  .obsidian/
    app.json
    community-plugins.json
    plugins/dropbox-sync/   # from qa:deploy — not overwritten by generate
```

## Source of truth for scenarios

Runbooks cite sections of [`docs/sync-scenarios.md`](../docs/sync-scenarios.md). Simulation coverage for those rows is tracked in [`SIMULATION_COVERAGE.md`](./SIMULATION_COVERAGE.md). How the matrix, simulator, and this vault fit together: [`docs/sync-scenario-testing.md`](../docs/sync-scenario-testing.md).

## Future

A second vault / iPad device for true two-plugin multi-writer rows is out of scope for this harness. Use Dropbox web as the peer for multi-device steps when needed.
