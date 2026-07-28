# 07 — Capitalisation

**Scenario:** `docs/sync-scenarios.md` §7  
**Seeds:** `_seeds/case/Note.md`  
**Remote wipe before reset:** yes

## Setup

1. Sync Now so `_seeds/case/Note.md` is on Dropbox with that display casing.

## Steps

1. Rename `Note.md` → `note.md` (case-only) in Obsidian / Finder.
2. Sync Now.
3. Confirm Dropbox display path is `note.md` (one file; Dropbox is case-insensitive).
4. Optional race: change casing locally one way and on Dropbox web the other before either sync finishes — first landing wins; no content loss (R8).

## Expected

- Case-only change propagates; single file remains.
- No stuck delete intent on unchanged `path_lower` (C1 / G6).
- Content conflicts are separate from casing (R2 vs R8).

## Log signals

- Case-only move / display-path update — not a content conflict.
- Cursor still advances (no stuck delete log from case rename).
