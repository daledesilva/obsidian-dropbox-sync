# 01 — Creating a file

## Setup

1. Sync Now so `_seeds/` matches Dropbox.
2. Prefer Sync Now once after each pass below (do not Sync Now between steps inside a pass).

---

## Pass 1 — A, B (one Sync Now)

Apply **all** of the following local changes in Obsidian **before** Sync Now. Do not sync between them.

### A — Local create

1. Create `_seeds/notes/created-live.md` with a short unique sentence (include a timestamp).

### B — Empty file still present

1. Confirm `_seeds/binaries/empty.txt` still exists at 0 bytes (do not delete it).

After A–B, local tree should include at least:

- `_seeds/notes/created-live.md`
- `_seeds/binaries/empty.txt` (0 bytes)
- `_seeds/notes/baseline.md` (untouched)

### Sync and validate (Pass 1)

1. Sync Now once.
2. Validate **logs** and **files** (vault + Dropbox agree).

**Expected**

- **A:** Upload of `_seeds/notes/created-live.md`; same bytes on Dropbox; not a conflict.
- **B:** Empty file remains content, not treated as missing; no delete/re-upload storm for `empty.txt`.

---

## Pass 2 — C (one Sync Now)

### C — Peer create (Dropbox web)

1. On Dropbox web, create `_seeds/notes/peer-created.md` with a short unique sentence.
2. Do not create that path locally first.

### Sync and validate (Pass 2)

1. Sync Now once.
2. Validate **logs** and **files** (vault + Dropbox agree).

**Expected**

- **C:** Download of `_seeds/notes/peer-created.md`; no conflict when only the peer wrote.
