# 07 — Capitalisation

## Setup

1. Sync Now so `_seeds/case/Note.md` matches Dropbox with that display casing.
2. Prefer Sync Now once after each pass below (do not Sync Now between steps inside a pass).

---

## Pass 1 — A (one Sync Now)

### A — Case-only file rename

1. Rename `_seeds/case/Note.md` → `_seeds/case/note.md` (case-only; same folder).

After A, local tree should include at least:

- `_seeds/case/note.md`
- no `_seeds/case/Note.md` as a second file

### Sync and validate (Pass 1)

1. Sync Now once.
2. Validate **logs** and **files** (vault + Dropbox agree).

**Expected**

- **A:** Case-only move / display-path update to `note.md`; one file remains on Dropbox; not a content conflict; no stuck delete intent on unchanged `path_lower` (C1 / G6); cursor still advances.

---

## Pass 2 — B (optional race)

### B — Competing case changes

1. Rename `_seeds/case/note.md` → `_seeds/case/NOTE.md` locally (do not sync yet).
2. On Dropbox web, rename the same path to a different casing (e.g. `Note.md`) and save.

### Sync and validate (Pass 2)

1. Sync Now once.
2. Validate **logs** and **files** (vault + Dropbox agree).

**Expected**

- **B:** Exactly one file remains; first landing casing wins; no content loss (R8).
