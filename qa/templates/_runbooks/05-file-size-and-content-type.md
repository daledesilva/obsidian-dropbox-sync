# 05 — File size and content type

## Setup

1. Sync Now so `_seeds/binaries/` matches Dropbox.
2. Prefer Sync Now once after each pass below (do not Sync Now between steps inside a pass).
3. Large-file rows (150MB+) are optional and slow — skip Pass 3 unless specifically testing resumable upload.

---

## Pass 1 — A, B (one Sync Now)

Confirm existing seeds; no local edits required unless a file is missing (then reseed).

### A — Empty file

1. Confirm `_seeds/binaries/empty.txt` exists at 0 bytes.

### B — Tiny binaries

1. Confirm `_seeds/binaries/tiny.png` exists.
2. Confirm `_seeds/binaries/tiny.pdf` exists.

### Sync and validate (Pass 1)

1. Sync Now once.
2. Validate **logs** and **files** (vault + Dropbox agree).

**Expected**

- **A:** Empty file is content, not absence; still on both sides.
- **B:** `tiny.png` and `tiny.pdf` round-trip; hash/upload success; no spurious conflicts.

---

## Pass 2 — C (optional binary conflict)

### C — Divergent PNG bytes

1. Change bytes in local `_seeds/binaries/tiny.png` (replace with different valid PNG bytes).
2. On Dropbox web, upload different bytes to `_seeds/binaries/tiny.png` (do not match local).

### Sync and validate (Pass 2)

1. Sync Now once.
2. Validate **logs** and **files** (vault + Dropbox agree).

**Expected**

- **C:** Two files (canonical + conflict copy); no text merge (R2); both byte streams preserved.

---

## Pass 3 — D (optional large file)

### D — Oversized upload

1. Copy a file larger than 150MB into `_seeds/binaries/large-upload.bin` (or any path under `_seeds/binaries/`).

### Sync and validate (Pass 3)

1. Sync Now once.
2. Validate **logs** and **files**.

**Expected**

- **D:** Resumable session or a clear failure (not infinite single-request retry); other files under `_seeds/binaries/` still sync.
