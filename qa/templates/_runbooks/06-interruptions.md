# 06 — Interruptions and other cases

## Setup

1. Sync Now so `_seeds/` matches Dropbox.
2. Prefer Sync Now once after each pass below (do not Sync Now between steps inside a pass).
3. Agent: ingest connected (interruption timing is easier with live logs).

---

## Pass 1 — A (mid-sync interrupt)

### A — Quit or disconnect mid-cycle

1. Edit `_seeds/notes/baseline.md` — append unique line `interrupt-1`.
2. Edit `_seeds/notes/conflict-target.md` — append unique line `interrupt-2`.
3. Edit `_seeds/notes/rename-me.md` — append unique line `interrupt-3`.
4. Start Sync Now; quit Obsidian or disable network mid-cycle; reopen/reconnect.

### Sync and validate (Pass 1)

1. Sync Now once after reconnect.
2. Validate **logs** and **files** (vault + Dropbox agree).

**Expected**

- **A:** Resume without losing either side’s originals (R7 temp writes); partial progress retained per file where possible; no corrupt destination files (atomic replace).

---

## Pass 2 — B (open editor deferral)

### B — Dirty local note vs remote change

1. Keep `_seeds/notes/baseline.md` open and dirty in the editor.
2. On Dropbox web, edit `_seeds/notes/baseline.md` to a different unique string and save.

### Sync and validate (Pass 2)

1. Sync Now once.
2. Validate **logs** and **files**.
3. Close/reload the note if deferred; Sync Now again if needed.

**Expected**

- **B:** Download/conflict/delete may defer briefly (R12) then apply or prompt within a bound; manual Sync Now later reaches the same conclusion (P5).

---

## Pass 3 — C (exclude bait)

### C — Out-of-scope paths

1. Confirm device exclude settings (or built-in excludes) cover paths under `_seeds/exclude-bait/` if you are testing excludes — otherwise note that bait files are currently in scope.
2. Do not delete `_seeds/exclude-bait/README.md` or `_seeds/exclude-bait/should-stay-local.md` unless your exclude test requires it.

### Sync and validate (Pass 3)

1. Sync Now once.
2. Validate **logs** and **files**.

**Expected**

- **C:** Out-of-scope paths are not treated as mass deletes of an unsynced section (P4); exclude skip reasons in logs when excluded.

---

## Pass 4 — D (debounce)

### D — Rapid typing with live sync

1. With live sync on, type rapidly in `_seeds/notes/baseline.md` for several seconds, then stop and wait for settle.

### Sync and validate (Pass 4)

1. Wait for live sync to settle (or Sync Now once if live sync is off).
2. Validate **logs** and **files**.

**Expected**

- **D:** One settled upload burst (R13), not one upload per keystroke.
