# 08 — Folders and empty folders

## Setup

1. Sync Now so `_seeds/folders/` matches Dropbox.
2. Prefer Sync Now once after each pass below (do not Sync Now between steps inside a pass).

---

## Pass 1 — A, B (one Sync Now)

Apply **all** of the following local changes in Obsidian **before** Sync Now. Do not sync between them.

### A — Create empty folder

1. Create empty folder `_seeds/folders/brand-new-empty/` (no files inside).

### B — Create folder with a file

1. Create `_seeds/folders/with-file/note.md` with a short unique sentence.

After A–B, local tree should include at least:

- `_seeds/folders/brand-new-empty/` (empty)
- `_seeds/folders/with-file/note.md`
- `_seeds/folders/empty-keep/.keep.md` (untouched)
- `_seeds/folders/nested/deep-note.md` (untouched)

### Sync and validate (Pass 1)

1. Sync Now once.
2. Validate **logs** and **files** (vault + Dropbox agree).

**Expected**

- **A:** Empty-folder remote behaviour matches product rules (G8) — folder appears on Dropbox, or absence is explicit/logged (not silent corruption).
- **B:** `_seeds/folders/with-file/note.md` uploaded; folder exists remotely via the file.

---

## Pass 2 — C (one Sync Now)

### C — Empty a populated folder

1. Delete `_seeds/folders/with-file/note.md`.
2. Leave the folder `_seeds/folders/with-file/` in place.

After C, local tree should include at least:

- `_seeds/folders/with-file/` (empty)
- no `_seeds/folders/with-file/note.md`

### Sync and validate (Pass 2)

1. Sync Now once.
2. Validate **logs** and **files** (vault + Dropbox agree).

**Expected**

- **C:** File gone on Dropbox; empty `_seeds/folders/with-file/` behaviour matches G8 on both sides.

---

## Pass 3 — D (optional name clash)

### D — File vs folder name clash

1. Create a local file `_seeds/folders/Draft` (file named `Draft` with no extension), **or** on Dropbox web create a folder `_seeds/folders/Draft/` while the other side has a file at that path — pick one clash direction and stick to it.

### Sync and validate (Pass 3)

1. Sync Now once.
2. Validate **logs** and **files**.

**Expected**

- **D:** Clash is reported; no unbounded retry loop.
