# 02 — Modifying a file

**Scenario:** `docs/sync-scenarios.md` §2  
**Seeds:** `_seeds/notes/baseline.md`

## Setup

1. Sync Now so `baseline.md` matches Dropbox.
2. Agent: ingest connected.

## Steps

1. Edit `_seeds/notes/baseline.md` — append a unique line.
2. Sync Now.
3. Confirm Dropbox web shows the new content.
4. Edit again (second modify), Sync Now, confirm both devices/peers would see the latest only (no conflict copies).
5. Optional: re-save without changing bytes; Sync Now — expect noop / no re-upload of identical content.

## Expected

- Local-only modify → upload; remote hash updates; no conflict file.
- Identical content after re-save → no spurious conflict.

## Log signals

- Plan: upload for the path; not conflict.
- content_hash / rev update recorded after success.
- Second identical sync: zero transfers or noop stats.
