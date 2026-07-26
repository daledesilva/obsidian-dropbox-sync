# 06 — Renaming and moving

**Scenario:** `docs/sync-scenarios.md` §6  
**Seeds:** `_seeds/notes/rename-me.md`, `_seeds/folders/nested/deep-note.md`  
**Remote wipe before reset:** yes

## Setup

1. Sync Now so rename/move targets exist on Dropbox.

## Steps

1. Rename `_seeds/notes/rename-me.md` → `renamed.md` in Obsidian.
2. Sync Now.
3. Confirm Dropbox shows `renamed.md` and not a stale `rename-me.md` (prefer server-side move / single file, not delete+upload of different bytes when content unchanged — G7).
4. Move `_seeds/folders/nested/deep-note.md` into `_seeds/folders/moved-here.md` (or a sibling folder).
5. Sync Now; confirm remote path updated.

## Expected

- Content unchanged across rename → one remote file at the new path.
- Peer devices adopt the new path without duplicating content.

## Log signals

- Move / rename plan (or delete+upload pair today — note deviation vs G7).
- No conflict copies when only the path changed and content matches.
