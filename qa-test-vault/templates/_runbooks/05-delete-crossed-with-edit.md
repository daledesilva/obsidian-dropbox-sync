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
4. Expect the edited content to be restored / uploaded; user notice that a delete was overridden by an edit.

### Delete with local bytes still present (R10)

1. Reseed or restore a known file on both sides.
2. Delete on Dropbox web; keep local bytes without editing (or with only mtime touch).
3. Sync Now.
4. Expect deletion at the canonical path plus a conflict copy preserving local bytes when durable delete evidence exists — never silent discard.

## Expected

- Edit beats delete (R5).
- Durable delete evidence + local bytes → conflict copy, not silent restore of the old name alone (R10).

## Log signals

- Upload / conflict copy creation rather than silent deleteLocal of divergent local content.
- Notice or log line about edit-vs-delete or local preservation.
