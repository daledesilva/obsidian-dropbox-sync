# 03 — Simultaneous editing

**Scenario:** `docs/sync-scenarios.md` §3  
**Seeds:** `_seeds/notes/conflict-target.md`  
**Remote wipe before reset:** yes

## Setup

1. Sync Now so `conflict-target.md` is on Dropbox.
2. Peer: Dropbox web (or another device) ready to edit the same file.

## Steps

1. Locally edit `conflict-target.md` to version **A** (do not sync yet if testing true race; or sync first then race the peer — follow one path consistently).
2. On Dropbox web, edit the same path to version **B** and save (Dropbox holds B).
3. Sync Now locally.
4. Inspect vault: Dropbox version should keep the canonical name; local divergent bytes become a Dropbox-style conflicted copy (R2–R4).
5. Sync Now again; conflict copy should upload and appear on Dropbox too (R3).

## Expected

- Two different contents → two real files; nothing discarded (R1).
- Canonical path holds the version already on Dropbox (R2).
- Conflict copy name resembles Dropbox’s `… conflicted copy YYYY-MM-DD` form (R4).

## Log signals

- Plan/action: conflict / keep_both (or equivalent).
- Upload of conflict copy path.
- No silent overwrite of either version.
