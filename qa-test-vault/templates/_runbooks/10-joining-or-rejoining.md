# 10 — Joining or rejoining

**Scenario:** `docs/sync-scenarios.md` §10  
**Remote wipe before reset:** yes (if you clear state)

## Setup

Destructive to local sync state. Prefer a throwaway Dropbox folder link for this runbook.

## Steps

### Fresh join

1. Note current linked Dropbox folder.
2. On a clean vault copy (or after clearing plugin sync state / IndexedDB for this vault — advanced), link the same Dropbox folder.
3. Sync Now with empty or partial local `_seeds/`.
4. Expect download of remote files; not a mass upload of emptiness as “deletes” without asking (R11 / join rules).

### Re-link (R11)

1. Change the linked Dropbox folder to a different (empty or other) folder in settings.
2. Expect an explicit re-link / intent prompt — **not** a silent mass delete of local files or mass wipe of the new remote.

## Expected

- Join downloads remote; identical content converges without conflict spam when hashes match.
- Re-link asks; never infers mass deletion solely from “everything missing on the other side” after a folder change (R11).

## Log signals

- Re-link / folder-identity prompt.
- Absence of unprompted mass deleteLocal / deleteRemote after link change.
- Full list_folder / cursor reset behaviour if implemented (G28).
