# 05 — Delete crossed with edit

## Setup

1. Sync Now so `_seeds/notes/cross-delete.md` matches Dropbox.
2. Prefer Sync Now once after each pass below (do not Sync Now between steps inside a pass).

---

## Pass 1 — A, B (one Sync Now)

Apply **both** of the following **before** Sync Now. Do not sync between them.

### A — Remote delete

1. On Dropbox web, delete `_seeds/notes/cross-delete.md`.

### B — Local edit (do not delete)

1. Edit the still-present local `_seeds/notes/cross-delete.md` to a new unique string.

After A–B:

- Dropbox has no `_seeds/notes/cross-delete.md`.
- Local vault still has `_seeds/notes/cross-delete.md` with the new string.

### Sync and validate (Pass 1)

1. Sync Now once.
2. Validate **logs** and **files** (vault + Dropbox agree).

**Expected**

- **A+B:** Edit wins over delete (R5) — edited content restored/uploaded at `_seeds/notes/cross-delete.md`; notice or log that edit beat delete; path exists on both sides with the local string.

---

## Pass 2 — C (ordinary remote delete — not R10)

Paths below assume Pass 1 left `_seeds/notes/cross-delete.md` synced again. If not, Sync Now once first so both sides match.

### C — Remote delete, no local edit

1. On Dropbox web, delete `_seeds/notes/cross-delete.md`.
2. Do **not** edit the local file.

### Sync and validate (Pass 2)

1. Sync Now once.
2. Validate **logs** and **files** (vault + Dropbox agree).

**Expected**

- **C:** Ordinary remote→local delete on a linked device — `_seeds/notes/cross-delete.md` removed locally; not R10.

---

## Pass 3 — D (fresh join / R10)

Requires a device that still has the file on disk but no usable sync cursor. Prefer a second Obsidian vault that never linked, **or** clear this vault’s plugin sync state (base + cursor) after the remote delete below. Full join wipe: runbook **11** / `bun run qa:empty` patterns.

### D — Durable delete evidence + local bytes, no cursor

1. Reseed or restore `_seeds/notes/cross-delete.md`, Sync Now so it is on Dropbox (linked device with base/cursor).
2. On Dropbox web, delete `_seeds/notes/cross-delete.md`.
3. Do **not** Sync yet. Leave the local file on disk; do not edit its content.
4. Clear this vault’s sync state (base + cursor), **or** switch to the never-linked second vault that still has the file.

### Sync and validate (Pass 3)

1. Sync Now once on that fresh-join device.
2. Validate **logs** and **files** (vault + Dropbox agree).

**Expected**

- **On Dropbox:** `_seeds/notes/cross-delete.md` must **not** exist; a conflict-copy sibling **must** exist (e.g. `_seeds/notes/cross-delete (Device …'s conflicted copy YYYY-MM-DD).md`) with the pre-sync local bytes.
- **Locally:** canonical `_seeds/notes/cross-delete.md` must **not** exist; same conflict-copy filename present with those bytes.
- Logs: `preserveAsConflictCopy` / R10 / `list_revisions` evidence; canonical path not restored; nothing silently discarded.
