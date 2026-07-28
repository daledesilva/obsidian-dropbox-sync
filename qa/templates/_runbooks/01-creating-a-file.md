# 01 — Creating a file

**Scenario:** `docs/sync-scenarios.md` §1  
**Seeds:** `_seeds/notes/`

## Setup

1. Confirm vault is linked and last Sync Now finished clean.
2. Agent: debug ingest connected; Send test log once.

## Steps

1. Create `_seeds/notes/created-live.md` with a short unique sentence (include a timestamp).
2. Sync Now (or wait for live sync).
3. In Dropbox web, open the linked folder and confirm the file exists with the same bytes.
4. (Optional peer) On Dropbox web, add `peer-created.md`, then Sync Now here and confirm download.

## Expected

- Local create → upload; remote appears at the same path.
- Peer create → download; no conflict when only one side wrote.
- Empty file create (optional): `_seeds/binaries/empty.txt` already exists — editing it to still-empty and syncing must not treat it as missing.

## Log signals

- Upload / plan action for the new path (not conflict).
- Cycle completes; cursor advances when the cycle is clean.
- No mass-delete guard for a single create.
