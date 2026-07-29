# 11 — Deletes a device never saw

## Setup

1. Sync Now so `_seeds/notes/never-saw-delete.md` matches Dropbox.
2. Prefer Sync Now once after each pass below (do not Sync Now between steps inside a pass).
3. Peer: Dropbox web. Prefer a second Obsidian vault that never had base state for the “never knew” device.

---

## Pass 1 — A (durable evidence → R10)

### A — Remote delete, then sync on a device that still has the file

1. On Dropbox web, delete `_seeds/notes/never-saw-delete.md`.
2. Do **not** Sync on the linked device yet.
3. On a device that still has `_seeds/notes/never-saw-delete.md` on disk but weak/no base for that path (fresh-join second vault, or clear this vault’s sync state for that path), leave the file unedited.

### Sync and validate (Pass 1)

1. Sync Now once on that device.
2. Validate **logs** and **files** (vault + Dropbox agree).

**Expected**

- **A:** With durable revision evidence: deletion stands at `_seeds/notes/never-saw-delete.md`; local bytes become a conflict copy (R10) that syncs everywhere — or, without evidence, an **ask** before re-upload or local remove (R6). Never silent resurrection or silent discard. Logs may show `list_revisions` / delete-evidence probe vs user-prompt path.
