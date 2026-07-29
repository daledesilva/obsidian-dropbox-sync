# 03 — Simultaneous editing

## Setup

1. Sync Now so `_seeds/notes/conflict-target.md` matches Dropbox.
2. Prefer Sync Now once after each pass below (do not Sync Now between steps inside a pass).
3. Peer: Dropbox web ready to edit the same path.

---

## Pass 1 — A, B (one Sync Now)

Apply **both** side edits **before** Sync Now. Do not sync between them.

### A — Local divergent edit

1. Edit `_seeds/notes/conflict-target.md` to version **A** (unique local string). Leave the note closed if you want resolution this cycle (open/dirty defers — R12).

### B — Peer divergent edit (Dropbox web)

1. On Dropbox web, edit `_seeds/notes/conflict-target.md` to version **B** (different unique string) and save.

After A–B:

- Local vault holds version **A** at `_seeds/notes/conflict-target.md`.
- Dropbox holds version **B** at `_seeds/notes/conflict-target.md`.

### Sync and validate (Pass 1)

1. Sync Now once.
2. Validate **logs** and **files** (vault + Dropbox agree).

**Expected**

- Canonical `_seeds/notes/conflict-target.md` keeps Dropbox’s version **B** (R2).
- Local version **A** becomes a conflicted-copy sibling (Dropbox-style name with device + date) (R4).
- Nothing discarded (R1); conflict / keep_both (or equivalent) in the plan.
- If the note was open/dirty: `deferring — file is open or dirty in editor` with `action: "conflict"` — resolution skipped this cycle; close the note and Sync Now again.

---

## Pass 2 — C (one Sync Now)

### C — Conflict copy uploads

1. Confirm the conflict-copy file from Pass 1 exists locally (do not delete it).

### Sync and validate (Pass 2)

1. Sync Now once (skip if Pass 1 already uploaded the conflict copy).
2. Validate **logs** and **files** (vault + Dropbox agree).

**Expected**

- **C:** Conflict-copy path exists on Dropbox too (R3); both versions present on both sides.
