# Sync scenario testing

## Why it exists

Release 0.2 closed the sync-scenario gap backlog in code, but regressions are easy: multi-device orderings, empty folders, and Dropbox-app peers do not show up in a single-device smoke test. This project therefore splits **automated simulation** (cheap, CI) from **manual Dropbox QA** (real OAuth + ingest logs) and keeps a row-numbered matrix aligned with `docs/sync-scenarios.md`.

## Conceptual understanding

| Layer | Role | Entry point |
|---|---|---|
| Unit / planner | Pure decisions, adapters in memory | `bun test` under `test/` |
| Scenario matrix | One test slot per scenario row 1–101 | `test/simulation/scenario-matrix.test.ts` |
| Coverage map | Which rows are real vs `todo` | `qa/SIMULATION_COVERAGE.md` |
| Manual QA vault | Real Dropbox + sandboxed Obsidian | `bun run qa:open` → in-repo `qa-test-vault/` via `obsidian-launcher` |

`test.todo` rows are intentional when they need harness work or a human Dropbox peer (large binaries, device sleep, re-link UI). Claiming a row means adding a `run` and updating the coverage map.

Open-file deferral and continuous-typing debounce are now automated for matrix rows **9 / 18 / 21 / 22 / 29** (plus unit suites under `test/background-sync-schedule.test.ts` and friends). See [Background sync triggers](background-sync-triggers.md) for the quiet-window / leaf-flush contracts those tests lock. Row **23** (unsaved buffer after device sleep) remains a stub.

### Delete protection / folder wipe regressions

Bulk delete, Skip+cursor hold, inferred folder wipes, and keep-empty-folder behaviour are locked outside the matrix as well — they pin bugs found in live QA (runbook [`04-deleting`](../qa/templates/_runbooks/04-deleting.md)):

| Layer | Files | What they lock |
|---|---|---|
| Guards | `test/guards.test.ts` | Folder actions peel with files; one folder wipe weighs above R9 threshold |
| Scope / disk folders | `test/sync-scope.test.ts`, `test/vault-adapter-disk-scan.test.ts` | Exact `.obsidian/plugins` is plugins; `listFolders` + `configDiskScan` sees config dirs |
| Planner | `test/plan-folder-items.test.ts` | `inferred_local_tree_wipe`; same-cycle `deleteLocalFolder`; unmanaged child block; keep empty |
| Executor | `test/executor.test.ts` | `deleteRemoteFolder` not_found soft-ok; local folder delete after file deletes |
| Simulator | `test/simulation/delete-protection.test.ts` | Skip holds cursor on remote-originated deletes; local/remote tree wipe; keep empty folder |

Manual runbook **04** remains required for Obsidian UI timing (Deletions segment before Dropbox) — simulation does not exercise `main.ts` multi-section deferDeletes.

### R5 / R10 / ordinary remote-delete

The three-way distinction in [R6 upload ask](r6-upload-ask.md) and runbook [`05-delete-crossed-with-edit`](../qa/templates/_runbooks/05-delete-crossed-with-edit.md) is locked as:

| Layer | Files | What they lock |
|---|---|---|
| Resurrection guard | `test/resurrection-guard.test.ts` | R10 rewrite; R6 ask/upload/discard/defer; `hasSyncCursor` skips R10; deferred re-gate; missing `listRevisions` |
| Executor | `test/executor.test.ts` (`preserveAsConflictCopy`) | Local rename + conflict upload; canonical absent both sides |
| Matrix | rows 34 (linked Dropbox-app delete, no conflict sibling), 35–40 (R5 edit×delete), 82–83 (fresh-join R10 / expired ask) | End-to-end contrast |

### Rename / move (G7 / G8)

File and folder renames/moves (including peer-side) and sync-panel rename vs move chips are locked outside the matrix — see [Rename and move detection](rename-move-detection.md):

| Layer | Files | What they lock |
|---|---|---|
| Plan enhancements | `test/plan-enhancements-rename.test.ts` | G7 local/remote file rename/move; ambiguous hash refusal; G8 populated local/remote folder rename/move; empty / folder+inner / sync-root / empty-vs-parent / sibling / hash-mismatch / child-out-of-tree fallbacks; bijection guards (local+peer) |
| Reporter | `test/summarize-actions.test.ts` | `isSameParentRename`; rename (`Aa`) vs move chips; agnostic modal titles |
| Executor | `test/executor.test.ts` (`moveRemoteFolder` / `moveLocalFolder`) | Base prefix rewrite so children do not ghost-delete next cycle |

After the solo validation pass on `release_0.2`, most rows 1–101 have real `run`s; remaining todos are listed under “Highest-priority uncovered” / “Remaining for manual” in [`qa/SIMULATION_COVERAGE.md`](../qa/SIMULATION_COVERAGE.md).

```mermaid
flowchart LR
  Spec[docs/sync-scenarios.md rows] --> Matrix[scenario-matrix.test.ts]
  Matrix --> Sims[SyncSimulator + MemoryRemote]
  Spec --> Runbooks[qa/templates runbooks]
  Runbooks --> Vault["qa-test-vault/ + obsidian-launcher"]
  Vault --> Ingest[Cursor Debug NDJSON]
```

## Flows

### Automated matrix cycle

1. `SyncSimulator` gives each device its own vault + store against one `MemoryRemoteStorage`.
2. Optional `DropboxAppDevice` writes with `forceUpload` (desktop-client overwrite), not plugin `add`/`update(rev)`.
3. Assertions check canonical content, conflict siblings, cursor progress, and folder presence.
4. `patchDeviceSettings({ deviceId: "test" })` stabilises conflict copy names in tests.

### Manual QA cycle

1. `bun run qa:open` builds, reseeds `qa-test-vault/` from `qa/` templates, and launches sandboxed Obsidian (`obsidian-launcher watch --plugin ./dist`). OAuth/`data.json` persist (no `--copy` by default).
2. Or `qa:generate` + `qa:deploy` into `SYNC_TESTER_VAULT` / `~/Documents/sync-tester` for system Obsidian.

Harness sources (`qa/generate.mjs`, `qa/templates/`) live **outside** the vault so deleting folders in Obsidian cannot wipe tracked runbooks.
3. Follow a runbook; capture decisions via debug ingest — see [Cursor Debug ingest](cursor-debug-ingest.md).

## Technical details

| Piece | Role |
|---|---|
| `SyncSimulator` / `Device` | Multi-device driver; `rename` / `renameFolder`; `setScanUnvouched` for G22; `addDeviceWithFailingRemote` |
| `DropboxAppDevice` | P3 peer; `forceUpload` / `move` / folder helpers on memory remote |
| `MemoryRemoteStorage.expireRevisions` | Clears revision history for row 83 ask path |
| `RecordingLog` | Captures `ruleId` / message for taxonomy checks |
| `applyResurrectionGuard({ hasSyncCursor })` | R10 only on fresh join — see [Sync gap closure](sync-gap-closure.md) |
| `qa:open` / `open-qa` / `qa:generate` / `qa:deploy` | `package.json` + `obsidian-launcher` |
| `qa:restart` | Local wipe + regenerate **with** `_seeds/` fixtures + open |
| `qa:empty` | Local wipe + regenerate **empty** vault (no fixtures) + open — runbook 10 |

## Technical Gotchas

- **Matrix failures are product bugs until proven otherwise.** Several G8/R10 defects only appeared when rows 32, 56, and 61 ran end-to-end.
- **Memory remote must preserve folder display casing.** Lowercasing `pathDisplay` invents false case-only `moveRemoteFolder` plans.
- **Incremental cursors omit empty folders from deltas.** Folder base rows must seed `buildFullRemoteState` or peers treat the folder as remotely deleted.
- **File planner must skip folders.** Folder `hash: null` coerced to `""` looked like `remote_modified_local_deleted`.
- **Manual reset does not wipe Dropbox.** Dirty remotes after delete/conflict/casing runbooks need a separate remote clear before `qa:reset`.
