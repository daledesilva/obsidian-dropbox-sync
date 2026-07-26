# 04 — Deleting a file

**Scenario:** `docs/sync-scenarios.md` §4  
**Seeds:** `_seeds/notes/deletable.md`  
**Remote wipe before reset:** yes

## Setup

1. Sync Now so `deletable.md` exists on Dropbox.
2. Agent: ingest connected.

## Steps

1. Delete `_seeds/notes/deletable.md` in Obsidian (or Finder with Obsidian closed — colder path).
2. Sync Now.
3. Confirm Dropbox no longer has the file.
4. Optional mass-delete: delete several `_seeds/bulk/bulk-*.md` files at once; expect delete-threshold confirmation when over the device threshold (default 5) (R9).

## Expected

- Intended delete propagates remotely.
- Mass delete prompts when over threshold; declining skips deletes only.
- Missing file with no durable delete evidence must not silently destroy the other side (R6) — use §11 for the ambiguous case.

## Log signals

- deleteRemote (or coalesced folder delete) for the path.
- Guard prompt / skip when bulk exceeds threshold.
- Cursor finalize only when delete log allows it.
