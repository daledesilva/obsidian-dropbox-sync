# Simulation coverage map

Branch: **`release_0.2`**. Maps [`docs/sync-scenarios.md`](../docs/sync-scenarios.md) sections to automated tests. Live Dropbox checks use [`templates/_runbooks/`](./templates/_runbooks/) — not CI.

Primary matrix: [`test/simulation/scenario-matrix.test.ts`](../test/simulation/scenario-matrix.test.ts) (rows 1–101). Gaps G1–G30 are closed in code. Remaining `test.todo` rows need Obsidian UI, large binaries, re-link settings, or real Dropbox-app peers.

When adding sims, claim the row in the matrix (add `run`) and update this table.

## Section → tests

| Section | Topic | Automated coverage | Status / gaps |
|--------:|-------|--------------------|---------------|
| §1 | Creating a file | matrix rows 1–7 | Covered |
| §2 | Modifying a file | matrix 8, 10–17; row 9 todo (G10 editor) | Covered except open-editor |
| §3 | Simultaneous editing | matrix 19–20, 24–25; 18/21–23 todo (editor) | Covered except editor deferral |
| §4 | Deleting | matrix 26–28, 30–34; 29 todo (open editor); guards + `delete-protection` + `plan-folder-items` (Skip cursor, tree wipe, keep empty); manual `04-deleting.md` | Covered |
| §5 | Delete × edit | matrix 35–40 | Covered |
| §6 | Renaming / moving | matrix 41–46 | Covered |
| §7 | Capitalisation | matrix 47–53 | Covered |
| §8 | Empty folders | matrix 54–62 | Covered |
| §9 | Folders with files | matrix 63–74; 75 todo (Dropbox-app mass folder) | Coalesce + rename covered |
| §10 | Join / rejoin | matrix 76–79, 81–83; 80 todo (re-link UI) | Covered except re-link |
| §11 | Unseen deletes | matrix 82–83; 84–85 todo (bulk / aged Dropbox-app) | R10 + expired ask covered |
| §12 | Size / content type | matrix 88–89, 96; 86–87/90–93 todo | Binary + excludes covered |
| §13 | Interruptions | matrix 94–96, 98–101; 97 todo (G10 defer) | Transfer failure + cursor covered |

## Supporting unit tests

| Area | Files |
|------|-------|
| Planner three-way | `test/planner.test.ts` |
| Guards / mass delete | `test/guards.test.ts`, `test/simulation/delete-protection.test.ts` (Skip cursor, tree wipe, keep empty) |
| Folder wipe planner | `test/plan-folder-items.test.ts` |
| Config folder disk scan | `test/vault-adapter-disk-scan.test.ts`, exact plugins path in `test/sync-scope.test.ts` |
| Folder delete coalesce | `test/delete-coalesce.test.ts` |
| Delete catch-up | `test/delete-catchup.test.ts` |
| Bulk / multi-device | `test/simulation/bulk.test.ts`, `test/simulation/two-device.test.ts` |
| Active file | `test/simulation/active-file.test.ts` |
| Network partial failure | `test/simulation/network-failure.test.ts`, `test/retry-set-cycle.test.ts` |
| Log taxonomy | `test/sync-log-taxonomy.test.ts` |
| Upload sessions | `test/upload-chunk.test.ts`, `test/dropbox-adapter-upload-session.test.ts` |

## Remaining for manual / harness (needs human or UI)

1. **G10** — open-editor deferral (rows 9, 18, 21–23, 29, 97)  
2. **G15 re-link** — row 80  
3. **Large transport** — rows 86–87, 91–93  
4. **Dropbox-app mass peers** — rows 75, 84–85 (use `qa:generate` runbooks)  
5. **Partial write / huge vault** — rows 90–91  

## Non-goals

- No Dropbox network tests in `bun test`.
- Dropbox-app peer rows that need Finder UI stay manual (runbooks + Dropbox web).
