# 09 — Folders containing files

**Scenario:** `docs/sync-scenarios.md` §9  
**Seeds:** `_seeds/bulk/` (~50 notes), `_seeds/folders/nested/`  
**Remote wipe before reset:** yes

## Setup

1. Sync Now so bulk + nested seeds are on Dropbox.

## Steps

1. Delete the entire `_seeds/bulk/` folder in Obsidian (or select all bulk notes and delete).
2. Sync Now.
3. If count exceeds delete threshold, confirm or decline the mass-delete prompt (R9).
4. On confirm: Dropbox folder/files should be gone; prefer coalesced folder delete when membership matches (R14).
5. Optional: add an extra file on Dropbox under that folder before local delete — coalesce should fall back to per-file deletes / refuse recursive delete of unverified members (R14).

## Expected

- Mass delete asks when over threshold.
- Recursive folder delete only when membership is confirmed (R14).
- Extra remote/local members block unsafe coalesce.

## Log signals

- Delete guard prompt and outcome.
- Coalesced folder delete vs per-file deletes in the plan/executor logs.
- Membership verification / blocker path if present.
