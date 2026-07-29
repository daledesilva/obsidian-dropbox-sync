# 04 — Deleting

## Setup

1. Sync Now so `_seeds/` and `_runbooks/` match Dropbox.
2. Prefer Sync Now once after each pass below (do not Sync Now between steps inside a pass).
3. Delete protection on; threshold at default (5) unless a step says otherwise.

---

## Pass 1 — A, B (one Sync Now)

Apply **all** of the following local changes in Obsidian **before** Sync Now. Do not sync between them.

### A — Local single-file delete

1. Delete `_seeds/notes/deletable.md`.

### B — Local: delete children, keep empty folder

1. Delete `_seeds/folders/empty-keep/.keep.md`.
2. Leave the folder `_seeds/folders/empty-keep/` in place (do not delete the folder).

After A–B, local tree should include at least:

- no `_seeds/notes/deletable.md`
- `_seeds/folders/empty-keep/` (empty)
- `_seeds/bulk/bulk-01.md` … `_seeds/bulk/bulk-50.md` (untouched)

### Sync and validate (Pass 1)

1. Sync Now once (approve Deletions if prompted — count should be under threshold for A+B alone).
2. Validate **logs** and **files** (vault + Dropbox agree).

**Expected**

- **A:** `deleteRemote` for `_seeds/notes/deletable.md`; gone on Dropbox.
- **B:** `.keep.md` gone on Dropbox; `_seeds/folders/empty-keep/` still exists on both sides (empty folder kept).

---

## Pass 2 — C, D (one Sync Now)

Apply **all** of the following on Dropbox web **before** Sync Now. Do not sync between them.

### C — Remote single-file delete

1. On Dropbox web, delete `_seeds/notes/rename-me.md`.

### D — Remote: delete children, keep empty folder

1. On Dropbox web, delete `_seeds/folders/nested/deep-note.md`.
2. Leave the folder `_seeds/folders/nested/` in place.

### Sync and validate (Pass 2)

1. Sync Now once (approve Deletions if prompted).
2. Validate **logs** and **files** (vault + Dropbox agree).

**Expected**

- **C:** `deleteLocal` for `_seeds/notes/rename-me.md`; gone from the vault; no re-upload.
- **D:** `deep-note.md` gone locally; `_seeds/folders/nested/` still exists on both sides (empty).

---

## Pass 3 — E (Skip holds cursor)

### E — Bulk local deletes, then Skip

1. Delete these files locally (leave `_seeds/bulk/` folder if the UI leaves it):
   - `_seeds/bulk/bulk-01.md`
   - `_seeds/bulk/bulk-02.md`
   - `_seeds/bulk/bulk-03.md`
   - `_seeds/bulk/bulk-04.md`
   - `_seeds/bulk/bulk-05.md`
   - `_seeds/bulk/bulk-06.md`

### Sync and validate (Pass 3)

1. Sync Now once — expect Deletions modal **before** any Dropbox deletes.
2. Click **Skip deletions**.
3. Sync Now again immediately — expect Deletions modal again (not “up to date” with deletes gone).
4. Validate **logs** and **files**: those six files still on Dropbox; `deletesSkipped` > 0; `holding Dropbox cursor` / `cursorUpdated: false`.

**Expected**

- **E:** No `deleteRemote` for the six paths until Approve; Skip does not consume the Dropbox cursor.

---

## Pass 4 — F (Approve deferred)

### F — Approve the skipped bulk deletes

1. No further local edits required — the six `bulk-0N.md` deletes from Pass 3 are still pending.

### Sync and validate (Pass 4)

1. Sync Now once → Deletions modal → click **Delete**.
2. Validate **logs** and **files** (vault + Dropbox agree).

**Expected**

- **F:** `deleteRemote` for `_seeds/bulk/bulk-01.md` … `bulk-06.md` only after Approve; those paths gone on Dropbox.

---

## Pass 5 — G (bulk local tree wipe, approve)

### G — Wipe remaining bulk locally

1. Delete all remaining `_seeds/bulk/bulk-07.md` … `_seeds/bulk/bulk-50.md`.
2. Delete the folder `_seeds/bulk/` itself if it is still present.

### Sync and validate (Pass 5)

1. Sync Now once → Deletions modal → click **Delete**.
2. Validate **logs** and **files** (vault + Dropbox agree).

**Expected**

- **G:** `deleteRemote` / `deleteRemoteFolder` / `inferred_local_tree_wipe` after confirm; `_seeds/bulk/` gone on Dropbox (no empty shell left that restores locally); must **not** delete `.obsidian/plugins`.

---

## Pass 6 — H (bulk remote → local, approve)

### H — Remote subtree wipe

1. On Dropbox web, delete the entire `_runbooks/` folder (all runbook markdown files under it).

### Sync and validate (Pass 6)

1. Sync Now once → Deletions modal → click **Delete**.
2. Validate **logs** and **files** (vault + Dropbox agree).

**Expected**

- **H:** `deleteLocal` + `deleteLocalFolder` in the same cycle; `_runbooks/` gone locally (no empty shell left for a second sync).
