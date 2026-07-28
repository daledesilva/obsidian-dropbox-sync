# 12 — File size and content type

**Scenario:** `docs/sync-scenarios.md` §12  
**Seeds:** `_seeds/binaries/` (empty file, tiny PNG, tiny PDF)

## Setup

1. Sync Now so binaries are on Dropbox.
2. Large-file rows (150MB+) are optional and slow — skip unless specifically testing resumable upload.

## Steps

1. Confirm `_seeds/binaries/empty.txt` (0 bytes) synced and is not treated as missing.
2. Confirm `_seeds/binaries/tiny.png` and `tiny.pdf` round-trip; open locally after a peer overwrite test if desired.
3. Binary conflict (optional): change PNG bytes locally and on Dropbox web differently → Sync Now → two files, no text merge (R2).
4. Large file (optional): copy a >150MB file into the vault, Sync Now — expect resumable session or a clear failure (not infinite useless retry of a single-request cap).

## Expected

- Empty file is content, not absence.
- Binary conflicts keep both byte streams; no merge.
- Oversized upload/download fails or chunks gracefully; other files still sync.

## Log signals

- Hash/upload success for tiny binaries.
- Conflict copy for binary clash.
- Clear error classification for oversized / out-of-space paths without stalling the whole vault forever.
