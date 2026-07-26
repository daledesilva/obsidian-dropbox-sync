# 11 — Deletes a device never saw

**Scenario:** `docs/sync-scenarios.md` §11  
**Seeds:** `_seeds/notes/never-saw-delete.md`  
**Remote wipe before reset:** yes

## Setup

1. Sync Now so the seed is on Dropbox.
2. Peer: Dropbox web.

## Steps

1. On Dropbox web, delete `never-saw-delete.md`.
2. Locally, simulate “never knew”: clear this device’s sync state for that path if you can (or use a second Obsidian vault that never had base state — preferred), **or** wait until revision evidence would be ambiguous (hard to wait 30 days — prefer the fresh-join device).
3. Sync Now on the device that still has the local file but weak/no delete evidence.
4. Expect an **ask** before re-upload or local remove — never silent resurrection or silent discard (R6).

## Expected

- With durable revision evidence: deletion stands; local bytes may become conflict copy (R10).
- Without evidence: prompt the user (R6).

## Log signals

- list_revisions / delete-evidence probe (if logged).
- User prompt path vs automatic deleteLocal/upload.
- No silent decision when evidence is missing.
