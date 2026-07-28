# 13 — Interruptions and other cases

**Scenario:** `docs/sync-scenarios.md` §13  
**Seeds:** `_seeds/notes/baseline.md`, `_seeds/exclude-bait/`

## Setup

1. Sync Now.
2. Agent: ingest connected (interruption timing is easier with live logs).

## Steps

1. **Mid-sync interrupt:** start Sync Now with a few pending uploads (edit several notes), quit Obsidian or disable network mid-cycle; reopen/reconnect; Sync Now again — expect resume without losing either side’s originals (R7 temp writes; partial progress retained per file where possible).
2. **Open editor deferral (R12):** keep `baseline.md` open/dirty; change it on Dropbox web; Sync Now — download/delete may defer briefly then apply or prompt within a bound.
3. **Exclude bait:** confirm paths under `_seeds/exclude-bait/` behave per device exclude settings (or built-in excludes) — out-of-scope paths must not be treated as mass deletes of an unsynced section (P4).
4. **Debounce (R13):** type rapidly in a note with live sync on; expect one settled upload burst, not one upload per keystroke.

## Expected

- Interrupted cycle does not corrupt destination files (atomic replace).
- Deferrals are bounded; manual Sync Now later reaches the same conclusion (P5).
- Exclude / scope boundaries do not invent deletions.

## Log signals

- Per-file success/failure isolation.
- Defer / active-file skip then retry.
- Exclude skip reasons; no unprompted mass delete of out-of-scope trees.
