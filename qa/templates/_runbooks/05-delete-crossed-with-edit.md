# 05 — Delete crossed with edit

**Scenario:** `docs/sync-scenarios.md` §5  
**Seeds:** `_seeds/notes/cross-delete.md`  
**Remote wipe before reset:** yes

## Setup

1. Sync Now so `cross-delete.md` is on Dropbox.

## Steps

### Edit wins over delete (R5)

1. On Dropbox web, delete `cross-delete.md`.
2. Locally edit the still-present file to a new unique string (do not delete).
3. Sync Now.
4. Expect the edited content to be restored / uploaded at `cross-delete.md`; user notice that a delete was overridden by an edit.

### Unchanged local after remote delete (not R10)

On a **linked** device that already has sync state for this file: remote delete + **no local edit** is an ordinary remote→local delete (runbook **04** A2). Sync Now should remove the local file. That is *not* R10.

### Fresh join still holding a deleted path (R10)

**What R10 means:** Dropbox’s revision history shows the path was deleted, but this device still has the file on disk and is joining without a usable sync cursor. The deletion must stand at the original name; the local content becomes a **conflict copy** that syncs everywhere. Neither silently restoring `cross-delete.md` nor silently discarding the local bytes is allowed.

Full script for this case: runbook **11**. Short version with this seed:

1. Sync Now so `cross-delete.md` is on Dropbox (linked device with base/cursor).
2. On Dropbox web, delete `cross-delete.md`.
3. **Do not Sync yet.** Leave the local file on disk; do not edit its content.
4. Make the next sync look like a **fresh join**: clear this vault’s plugin sync state (base + cursor), **or** prefer a second Obsidian vault that still has the file on disk but never linked (see runbook **11**).
5. Sync Now on that fresh-join device.
6. Check both sides after sync finishes:

   **On Dropbox**
   - `_seeds/notes/cross-delete.md` must **not** exist (deletion stands; no silent restore).
   - A conflict-copy sibling **must** exist, e.g. `_seeds/notes/cross-delete (Device …'s conflicted copy YYYY-MM-DD).md`.
   - That conflict copy holds the same bytes that were in the local file before sync.

   **Locally (vault)**
   - `_seeds/notes/cross-delete.md` must **not** exist (plugin renames it away; canonical path stays deleted).
   - The same conflict-copy filename must exist in `_seeds/notes/`.
   - Conflict-copy content matches what the local file had before sync (nothing silently discarded).

## Expected

- Edit beats delete on a linked device (R5).
- Linked device, remote delete, no edit → ordinary local remove (not R10).
- Fresh join + durable delete evidence + local file still on disk → conflict copy; canonical path stays deleted (R10).

## Log signals

- R5: upload / restore of edited content; notice or log that edit beat delete.
- R10: `preserveAsConflictCopy` / “R10” / deletion evidence from `list_revisions`; conflict-copy upload; canonical path not restored.
