# Simulation coverage map

Branch: **`release_0.2`**. Maps [`docs/sync-scenarios.md`](../docs/sync-scenarios.md) sections to automated tests. Live Dropbox checks use [`templates/_runbooks/`](./templates/_runbooks/) — not CI.

Primary matrix: [`test/simulation/scenario-matrix.test.ts`](../test/simulation/scenario-matrix.test.ts) (rows 1–101; rows without `run` are stubs / `gap`).

When adding sims for sync-exception work, claim the row in the matrix (add `run`) and update this table.

## Section → tests

| Section | Topic | Automated coverage | Status / gaps |
|--------:|-------|--------------------|---------------|
| §1 | Creating a file | `scenario-matrix` rows 1–2 (+ stubs 3–7); `two-device` create/sync; `planner` new local→upload | Gaps G4/G1/G2 on identical/divergent create; Dropbox-app peer not simulated |
| §2 | Modifying a file | `scenario-matrix` 8, 16; `two-device` sequential edit; `planner` local/remote-only change | Gaps G10 open-editor, G2 conflict winner/naming, G23 Dropbox-app |
| §3 | Simultaneous editing | `two-device` conflict keep-both / resolver variants; matrix stubs 18–25 | **Priority:** R2–R4 conflict naming (`… conflicted copy`); G18 debounce; G1/G2 |
| §4 | Deleting a file | `delete-protection`; `two-device` delete prop; matrix 27, 30; `planner` deleteRemote/deleteLocal | Gaps G3/G22/G28 ambiguous missing; R6 ask path |
| §5 | Delete × edit | `two-device` delete+edit cross; `planner` edit-beats-delete | **Priority:** R10 conflict-on-delete-evidence; notices |
| §6 | Renaming / moving | `delete-protection` rename as delete+upload; matrix stubs 41–46 | **Priority G7** server-side move |
| §7 | Capitalisation | matrix stubs 47–53 | **Priority G6 / C1** `basePathDisplay`; case-only move |
| §8 | Empty folders | matrix stubs 54–62 | **Priority G8** folder tracking |
| §9 | Folders with files | `delete-coalesce.test.ts`; matrix stubs 63–75; `bulk` | **Priority R14** membership; partial coalesce covered in unit tests |
| §10 | Join / rejoin | matrix stubs 76–80 | **Priority R11 / G15 / G28** re-link vs mass delete |
| §11 | Unseen deletes | matrix stubs (see §11 rows in matrix) | **Priority R6** ask without durable evidence |
| §12 | Size / content type | `two-device` empty file; matrix large-file stubs | Large upload session / mobile memory uncovered in sim |
| §13 | Interruptions | `network-failure`; `active-file`; `abort` tests | G10/G27 deferral bounds; P4 exclude scope |

## Supporting unit tests

| Area | Files |
|------|-------|
| Planner three-way | `test/planner.test.ts` |
| Guards / mass delete | `test/guards.test.ts`, `test/simulation/delete-protection.test.ts` |
| Folder delete coalesce | `test/delete-coalesce.test.ts` |
| Delete catch-up | `test/delete-catchup.test.ts` |
| Bulk / multi-device | `test/simulation/bulk.test.ts` |
| Active file | `test/simulation/active-file.test.ts` |
| Network partial failure | `test/simulation/network-failure.test.ts` |

## Highest-priority uncovered (current redesign)

Claim these in `scenario-matrix.test.ts` (and this file) as implementation lands:

1. **G6 / C1** — casing / `basePathDisplay`; no stuck delete on case-only rename  
2. **G7** — rename/move as server-side move  
3. **R6 / R10** — delete evidence ask; local bytes → conflict copy  
4. **R2–R4** — Dropbox-style conflicted-copy naming + sync everywhere  
5. **R14** — folder membership before recursive delete  
6. **R11** — re-link is not mass delete  

## Non-goals

- No Dropbox network tests in `bun test`.
- Dropbox-app peer rows stay manual (runbooks + Dropbox web).
