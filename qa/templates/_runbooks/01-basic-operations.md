# 01 — Basic operations

Covers simple create, modify, delete, capitalisation, empty folders, and deleting a folder that contains files (§1, §2, §4 simple, §7, §8, §9 simple). Each letter uses a **different** path so one Sync Now keeps log chips separate.

Bulk Skip / tree-wipe / coalesce-blocker cases: runbook **03**.

## Setup

1. Sync Now so `_seeds/` matches Dropbox.
2. Prefer Sync Now once after each pass below (do not Sync Now between steps inside a pass).
3. Delete protection on; threshold at default (5).

---

## Pass 1 — A–H (one Sync Now)

Apply **all** of the following local changes in Obsidian **before** Sync Now. Do not sync between them. Do not touch any path except the one named in its letter.

### A — Create a file (§1)

1. Create `_seeds/notes/created-live.md` with a short unique sentence (include a timestamp).

### B — Modify a file (§2)

1. Edit `_seeds/notes/baseline.md` — append one unique line (include a timestamp).

### C — Delete a file (§4)

1. Delete `_seeds/notes/deletable.md`.

### D — Case-only rename (§7)

1. Rename `_seeds/case/Note.md` → `_seeds/case/note.md` (case-only; same folder).

### E — Create empty folder (§8)

1. Create empty folder `_seeds/folders/brand-new-empty/` (no files inside).

### F — Create folder with a file (§8)

1. Create `_seeds/folders/with-file/inner.md` with a short unique sentence.

### G — Delete children, keep empty folder (§8)

1. Delete `_seeds/folders/empty-keep/.keep.md`.
2. Leave the folder `_seeds/folders/empty-keep/` in place.

### H — Delete folder containing files (§9)

1. Delete the entire folder `_seeds/folders/nested/` (includes `_seeds/folders/nested/deep-note.md`).

After A–H, local tree should include at least:

- `_seeds/notes/created-live.md`
- `_seeds/notes/baseline.md` (with appended line)
- no `_seeds/notes/deletable.md`
- `_seeds/case/note.md` (not `Note.md`)
- `_seeds/folders/brand-new-empty/` (empty)
- `_seeds/folders/with-file/inner.md`
- `_seeds/folders/empty-keep/` (empty)
- no `_seeds/folders/nested/`
- `_seeds/bulk/` (untouched)
- `_seeds/notes/rename-me.md` (untouched)
- `_seeds/binaries/empty.txt` (untouched)

### Sync and validate (Pass 1)

1. Sync Now once (approve Deletions if prompted — C+G+H alone should stay under or near threshold depending on folder counts).
2. Validate **logs** and **files** (vault + Dropbox agree).

**Expected**

- **A:** Upload `_seeds/notes/created-live.md`; same bytes on Dropbox; not a conflict.
- **B:** Upload `_seeds/notes/baseline.md`; Dropbox shows the new line; no conflict copy.
- **C:** `deleteRemote` for `_seeds/notes/deletable.md`; gone on Dropbox.
- **D:** Case-only move / display-path update to `note.md`; one file remains; not a content conflict; cursor still advances.
- **E:** Empty-folder behaviour matches G8 (present on Dropbox or explicitly logged).
- **F:** Upload `_seeds/folders/with-file/inner.md`; folder exists remotely via the file.
- **G:** `.keep.md` gone on Dropbox; `_seeds/folders/empty-keep/` still exists on both sides.
- **H:** `_seeds/folders/nested/` gone on Dropbox (file + folder); prefer folder delete / tree wipe for that path — not a restore of the empty shell in the same cycle.

---

## Pass 2 — I (one Sync Now)

### I — Peer create (§1)

1. On Dropbox web, create `_seeds/notes/peer-created.md` with a short unique sentence.
2. Do not create that path locally first.

### Sync and validate (Pass 2)

1. Sync Now once.
2. Validate **logs** and **files** (vault + Dropbox agree).

**Expected**

- **I:** Download `_seeds/notes/peer-created.md`; no conflict when only the peer wrote.
