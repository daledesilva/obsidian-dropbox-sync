# Simulation coverage map

Branch: **`release_0.2`**. Maps [`docs/sync-scenarios.md`](../docs/sync-scenarios.md) sections to automated tests. Live Dropbox checks use [`templates/_runbooks/`](./templates/_runbooks/) — not CI.

Primary matrix: [`test/simulation/scenario-matrix.test.ts`](../test/simulation/scenario-matrix.test.ts) (rows 1–101). Gaps G1–G30 are closed in code; remaining `test.todo` rows need harness work (open editors, large binaries, re-link UI) or Dropbox-app manual runbooks.

When adding sims, claim the row in the matrix (add `run`) and update this table.

## Section → tests

| Section | Topic | Automated coverage | Status / gaps |
|--------:|-------|--------------------|---------------|
| §1 | Creating a file | matrix rows 1–7 (incl. Dropbox-app peer) | Covered |
| §2 | Modifying a file | matrix 8, 10–17; open-editor row 9 still todo (G10 harness) | Covered except editor deferral |
| §3 | Simultaneous editing | matrix 19–20, 24; rows 18/21–23/25 todo (editor / debounce) | Conflict naming + propagate covered |
| §4 | Deleting a file | matrix 26–28, 30, 32–34; 29/31 todo | Covered |
| §5 | Delete × edit | matrix 35–37, 39–40; 38 todo | Covered |
| §6 | Renaming / moving | matrix 41–42, 46; 43–45 todo | Server-side rename covered |
| §7 | Capitalisation | matrix 47–48, 50–51, 53; 49/52 todo | Case rename + C1 cursor covered |
| §8 | Empty folders | matrix 54–56, 61–62; 57–60 todo | Create/delete/peer create covered |
| §9 | Folders with files | matrix 63; 64–75 todo | File-in-folder covered; coalesce rows next |
| §10 | Join / rejoin | matrix 76–79, 81; 80 todo (re-link UI) | Fresh join + R10 covered |
| §11 | Unseen deletes | matrix 82; 83–85 todo (expired revisions) | R10 fresh-join covered |
| §12 | Size / content type | matrix 88–89, 96; large-file rows todo | Binary conflict + excludes covered |
| §13 | Interruptions | matrix 98–99, 101; 94–95/97/100 todo | Conflict-copy delete + cursor reset covered |

## Supporting unit tests

| Area | Files |
|------|-------|
| Planner three-way | `test/planner.test.ts` |
| Guards / mass delete | `test/guards.test.ts`, `test/simulation/delete-protection.test.ts` |
| Folder delete coalesce | `test/delete-coalesce.test.ts` |
| Delete catch-up | `test/delete-catchup.test.ts` |
| Bulk / multi-device | `test/simulation/bulk.test.ts`, `test/simulation/two-device.test.ts` |
| Active file | `test/simulation/active-file.test.ts` |
| Network partial failure | `test/simulation/network-failure.test.ts` |
| Log taxonomy | `test/sync-log-taxonomy.test.ts` |
| Upload sessions | `test/upload-chunk.test.ts`, `test/dropbox-adapter-upload-session.test.ts` |

## Highest-priority uncovered (harness / manual)

1. **G10** — open-editor deferral bounds (rows 9, 18, 21, 29, 97) — needs editor mock in simulator  
2. **§9 coalesce** — folder delete with extras / excluded children (rows 64–75)  
3. **G15 re-link** — row 80 (engine hook + UI)  
4. **Large transport** — rows 86–87, 91–93 (size / memory)  
5. **Dropbox-app peer rows** without automated peers — use `qa:generate` runbooks  

## Non-goals

- No Dropbox network tests in `bun test`.
- Dropbox-app peer rows that need Finder UI stay manual (runbooks + Dropbox web).
