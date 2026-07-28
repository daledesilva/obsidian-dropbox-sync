# 06 — Renaming and moving

**Scenario:** `docs/sync-scenarios.md` §6  
**Seeds:** `_seeds/notes/rename-me.md`, `_seeds/notes/baseline.md`, `_seeds/folders/nested/deep-note.md`, `_seeds/folders/empty-keep/`, `_seeds/bulk/`, `_seeds/binaries/`, `_seeds/case/`  
**Remote wipe before reset:** yes  
**Contract:** Rename/move detection is best-effort — see `docs/rename-move-detection.md`. Confident detections → server-side move + rename/move chips. Ambiguous/compound cases → create+delete (or G7 file move) is **accepted**, not a failure.

## Setup

1. Sync Now so `_seeds/` matches Dropbox.
2. Prefer Sync Now once after each category below (do not batch unrelated categories into one plan unless the category says so).

## A — Simple file rename (G7)

1. Rename `_seeds/notes/rename-me.md` → `_seeds/notes/renamed.md` in Obsidian (same parent).
2. Sync Now.

**Expected**

- Prefer server-side move: one remote file at the new path; no stale `rename-me.md`.
- Sync panel: **rename** chip (`Aa`), not upload+delete of different bytes when content unchanged.

## B — Simple file move (G7)

1. Move `_seeds/folders/nested/deep-note.md` to a sibling path (e.g. `_seeds/folders/moved-here.md` or into another existing folder under `_seeds/`).
2. Sync Now.

**Expected**

- Remote path updated; content unchanged.
- Sync panel: **move** chip (cross-directory).

## C — Intact populated folder rename (G8)

1. Rename a whole folder **without** renaming files inside it, e.g. `_seeds/case` → `_seeds/case-renamed` (keep `Note.md` at the same relative path).
2. Sync Now.

**Expected**

- Prefer one folder move (`moveRemoteFolder`): children travel with the folder; no mass upload of every child.
- Sync panel: **rename** chip when the parent directory of the folder path is unchanged.

## D — Intact populated folder move (G8)

1. Move an intact populated folder to a new parent, e.g. `_seeds/binaries` → `_seeds/bulk/binaries` (do not rename inner files).
2. Sync Now.

**Expected**

- Prefer one folder move; remote tree under the new path matches local relative layout.
- Sync panel: **move** chip.

## E — Sibling folder renames in one Sync Now

1. Without renaming `_seeds` itself, rename two sibling folders in Obsidian before syncing, e.g.:
   - `_seeds/notes` → `_seeds/notes-renamed`
   - `_seeds/bulk` → `_seeds/bulk-renamed`  
   (leave relative file names inside each folder unchanged).
2. Sync Now once.

**Expected**

- Prefer **two** folder moves (one per sibling); no cross-claim (notes content must not land under `bulk-renamed` as a false pair).
- Rename chips for same-parent folder renames; no spurious wipe of unrelated `_seeds` children.

## F — Folder rename + inner file rename (same cycle) — fallback OK

1. Sync so `_seeds/folders/nested/` is on Dropbox.
2. In Obsidian, **before** Sync Now: rename the folder **and** a file inside it, e.g.:
   - `_seeds/folders/nested` → `_seeds/folders/nested-renamed`
   - `deep-note.md` → `deep-note-renamed.md` inside that folder
3. Sync Now.

**Expected**

- **Not** required to be one `moveRemoteFolder` with residuals.
- Accepted: create+delete for the folder shell and/or **G7 file move** for the unique-hash note; upload/delete chips are fine.
- End state: one copy of the note content at the new path; no silent loss; no conflict copies when only paths changed.

## G — Empty folder rename — fallback OK

1. Create a truly empty folder (no files), e.g. `_seeds/folders/empty-to-rename/`, Sync Now so it exists on Dropbox if the plugin tracks empty folders.
2. Rename it to `_seeds/folders/empty-renamed/` (still empty).
3. Sync Now.

**Expected**

- **No** invented folder move required — `createRemoteFolder` + `deleteRemoteFolder` (or equivalent) is accepted.
- Upload/delete / folder create-delete chips are fine; do not treat absence of a rename chip as a bug.

## H — Parent rename + child moved out (compound) — fallback OK

1. Sync so `_seeds` is populated on Dropbox.
2. In one offline window:
   - Rename parent `_seeds` → `_seeds (Renamed)` **or** leave parent and only move children — either compound pattern from QA.
   - Also move/rename one child **out** of that tree (e.g. `_seeds/notes` → vault-root `notes (Renamed)`, and/or rename a file inside a moved folder).
3. Sync Now.

**Expected**

- Detection may fall back to create+delete for vacated shells; delete-protection may prompt for leftover empty parents — **confirm only real leftovers**, not mass wipe of content that still exists under new paths.
- **Must not:** false-pair a small folder onto a larger renamed parent (e.g. empty folder or `notes` claiming `_seeds (Renamed)` as its move target).
- Final vault + Dropbox should agree on paths and content; no silent data loss.

## I — Optional peer check

1. After any category above succeeds on this device, open Dropbox web (or a second vault) and confirm the same paths.
2. Peer adopts remote renames/moves without duplicating content.

## Log signals

| Category | Prefer to see | Also OK |
|---|---|---|
| A–B file | `moveRemote`, rename/move chip | — |
| C–E intact folder | `moveRemoteFolder`, rename/move chip | — |
| F folder+inner | no compound residual folder move; often `moveRemote` for the file | create+delete |
| G empty rename | create+delete folders | — |
| H compound | file/folder moves for intact pieces; deletes for vacated shells | delete-protection prompt for leftovers |

- No conflict copies when only the path changed and content matches.
- Failures: `too_many_write_operations` on many parallel moves — retry Sync Now; not a detection bug.
