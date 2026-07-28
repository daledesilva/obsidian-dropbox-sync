# 08 — Folders and empty folders

**Scenario:** `docs/sync-scenarios.md` §8  
**Seeds:** `_seeds/folders/empty-keep/` (placeholder `.gitkeep`-style note may be present), `_seeds/folders/nested/`  
**Remote wipe before reset:** yes

## Setup

1. Sync Now. Note which empty folders the plugin actually tracks today (G8).

## Steps

1. Create a new empty folder `_seeds/folders/brand-new-empty/` in Obsidian.
2. Sync Now; check whether Dropbox shows the empty folder (plugin may only sync via files — record actual behaviour).
3. Create a file inside it, Sync Now — folder should exist remotely via the file.
4. Delete the file and leave the folder empty; Sync Now — observe empty-folder remote behaviour.
5. Optional: create a path that would clash file vs folder name `Draft` across devices — expect report, not infinite retry.

## Expected

- Folders with files sync.
- Empty-folder behaviour matches product rules (G8); deviations should be logged clearly.
- File vs folder name clash is reported, not looped forever.

## Log signals

- Folder create/delete/move actions or explicit “unsupported / reported” messages.
- No unbounded retry on name clash.
