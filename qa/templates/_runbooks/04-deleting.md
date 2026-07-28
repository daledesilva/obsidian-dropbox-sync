# 04 — Deleting

**Scenario:** `docs/sync-scenarios.md` §4 (plus G8 empty-folder / tree-wipe cases)  
**Seeds:** `_seeds/notes/deletable.md`, `_seeds/bulk/bulk-*.md`, `_seeds/` tree, `_runbooks/`  
**Remote wipe before reset:** yes

Use this runbook after any change to delete protection, folder deletes, coalesce, or cursor finalize on Skip. The regressions below were found in live QA — each category must pass before calling deletes “done.”

## Setup

1. Sync Now so `_seeds/` and `_runbooks/` match Dropbox.
2. Agent: ingest connected (`/debug-ingest` / Send test log).
3. Delete protection on; threshold at default (5) unless a step says otherwise.

---

## A. Standard deletes (either way)

Single-file deletes in both directions. Confirms intent tracking and remote/local apply without bulk UI.

### A1 — Local → remote

1. Delete `_seeds/notes/deletable.md` in Obsidian (or Finder with Obsidian closed — colder path).
2. Sync Now.
3. Confirm Dropbox no longer has the file.

**Expected / logs:** `deleteRemote` for the path; cursor finalize allowed when the delete log clears.

### A2 — Remote → local

1. Delete the same (or another synced) file on Dropbox web.
2. Sync Now.
3. Confirm the vault no longer has the file (trashed/removed per adapter).

**Expected / logs:** `deleteLocal` for the path; no re-upload of the deleted content.

---

## B. Bulk deletes (either way)

Mass file deletes that trip R9. Folder actions must **not** run before the confirm modal; Skip must not advance the Dropbox cursor.

### B1 — Bulk local → remote (approve)

1. Delete many files under `_seeds/` at once (e.g. wipe most of `_seeds` in Finder/Obsidian, enough to exceed the threshold). Prefer a tree wipe so the plan includes `deleteRemote` **and** `deleteRemoteFolder` / `inferred_local_tree_wipe`.
2. Sync Now — expect a **Deletions** segment and the confirm modal **before** any Dropbox deletes.
3. Confirm logs show deferred delete counts including folders (e.g. `deferredDeletes` with file + folder counts) **before** you click Delete.
4. Click **Delete**.
5. Confirm Dropbox: files gone **and** emptied parent folders gone (no empty shell left on Dropbox that then restores locally).

**Expected / logs:** `deleteRemote` / `deleteRemoteFolder` only **after** confirm; Deletions segment succeeds (not red for `not_found` on already-gone parents). Must **not** delete `.obsidian/plugins` during a Settings section pass.

### B2 — Bulk local → remote (Skip holds cursor)

1. Repeat a smaller bulk local delete (or restore `_seeds`, sync, delete again).
2. Sync Now → confirm modal → click **Skip deletions**.
3. Sync Now again immediately.

**Expected / logs:** First cycle: `deletesSkipped` > 0, `holding Dropbox cursor` / `cursorUpdated: false`. Second cycle: delete prompt returns (not “up to date” with deletes vanished). Files still on Dropbox until you Approve.

### B3 — Bulk remote → local (approve)

1. On Dropbox web, delete a whole synced subtree (e.g. wipe `_runbooks/` or a large `_seeds` subfolder remotely).
2. Sync Now → approve the Deletions modal.
3. Confirm vault: files gone **and** the emptied folder removed locally in the **same** cycle (`deleteLocal` + `deleteLocalFolder`).

**Expected / logs:** Plan includes `deleteLocalFolder` for the wiped folder even while children still existed at plan time; folder delete runs after file deletes; no empty local folder left behind requiring a second sync.

---

## C. Bulk files in folders, empty folder kept

Delete **files** inside a folder but leave the folder itself. Empty folders are first-class sync state (G8) — they must remain on both sides.

### C1 — Local: delete children, keep empty folder

1. Pick a folder that has several synced files (e.g. under `_seeds/bulk/` or a runbook folder).
2. Delete **all files inside** but **do not** delete the folder.
3. Sync Now (approve if prompted).
4. Confirm Dropbox: files gone; **empty folder still exists**.
5. Confirm vault: empty folder still exists (not removed, not re-filled).

### C2 — Remote: delete children, keep empty folder

1. On Dropbox web, delete the files inside a synced folder but leave the folder.
2. Sync Now (approve if prompted).
3. Confirm vault: files gone; **empty folder still exists** locally.
4. Confirm Dropbox: empty folder still exists.

### C3 — Do not confuse with full tree wipe

If you delete the folder itself (or wipe the tree including the folder), that is category **B**, not C — empty shells should **not** remain. Category C is only “children gone, folder path intentionally kept.”

---

## Ambiguous / related

- Missing file with no durable delete evidence must not silently destroy the other side (R6) — use runbook **11**.
- Delete crossed with edit — runbook **05**.
- Folder create/empty-only matrix — runbooks **08** / **09**.

## Log signals (quick checklist)

| Signal | Means |
|--------|--------|
| `deferredDeletes` with file + folder counts before modal | Folder deletes peeled correctly |
| Dropbox deletes only after Approve | No pre-modal `deleteRemoteFolder` |
| `holding Dropbox cursor` after Skip | Skip did not consume remote deltas |
| `inferred_local_tree_wipe` / `deleteRemoteFolder` after local tree wipe | Empty remote shells cleared |
| `deleteLocalFolder` with remote tree wipe | Empty local shells cleared same cycle |
| No `deleteRemoteFolder` on `.obsidian/plugins` during settings | Scope + disk folder listing OK |
| Soft-ok `not_found` on folder delete | No false-red Deletions bar |
