# 03 — Delete protection

Bulk deletes, Skip-holds-cursor, remote tree wipe, and coalesce blockers (§4 advanced / §9 R14). Simple single-file and small-folder deletes live in runbook **01**.

## Setup

1. Sync Now so `_seeds/` and `_runbooks/` match Dropbox.
2. Prefer Sync Now once after each pass below (do not Sync Now between steps inside a pass).
3. Delete protection on; threshold at default (5).

---

## Pass 1 — A (Skip holds cursor)

### A — Bulk local deletes, then Skip

1. Delete these files locally (leave `_seeds/bulk/` folder if the UI leaves it):
   - `_seeds/bulk/bulk-01.md`
   - `_seeds/bulk/bulk-02.md`
   - `_seeds/bulk/bulk-03.md`
   - `_seeds/bulk/bulk-04.md`
   - `_seeds/bulk/bulk-05.md`
   - `_seeds/bulk/bulk-06.md`

### Sync and validate (Pass 1)

1. Sync Now once — expect Deletions modal **before** any Dropbox deletes.
2. Click **Skip deletions**.
3. Sync Now again immediately — expect Deletions modal again (not “up to date” with deletes gone).
4. Validate **logs** and **files**: those six files still on Dropbox; `deletesSkipped` > 0; `holding Dropbox cursor` / `cursorUpdated: false`.

**Expected**

- **A:** No `deleteRemote` for the six paths until Approve; Skip does not consume the Dropbox cursor.

---

## Pass 2 — B (Approve deferred)

### B — Approve the skipped bulk deletes

1. No further local edits — the six `bulk-0N.md` deletes from Pass 1 are still pending.

### Sync and validate (Pass 2)

1. Sync Now once → Deletions modal → click **Delete**.
2. Validate **logs** and **files** (vault + Dropbox agree).

**Expected**

- **B:** `deleteRemote` for `_seeds/bulk/bulk-01.md` … `bulk-06.md` only after Approve; those paths gone on Dropbox.

---

## Pass 3 — C (bulk local tree wipe, approve)

### C — Wipe remaining bulk locally

1. Delete all remaining `_seeds/bulk/bulk-07.md` … `_seeds/bulk/bulk-50.md`.
2. Delete the folder `_seeds/bulk/` itself if it is still present.

### Sync and validate (Pass 3)

1. Sync Now once → Deletions modal → click **Delete**.
2. Validate **logs** and **files** (vault + Dropbox agree).

**Expected**

- **C:** `deleteRemote` / `deleteRemoteFolder` / `inferred_local_tree_wipe` after confirm; `_seeds/bulk/` gone on Dropbox (no empty shell left that restores locally); must **not** delete `.obsidian/plugins`; prefer coalesced folder delete when membership matches (R14).

---

## Pass 4 — D (bulk remote → local, approve)

### D — Remote subtree wipe

1. On Dropbox web, delete the entire `_runbooks/` folder (all runbook markdown files under it).

### Sync and validate (Pass 4)

1. Sync Now once → Deletions modal → click **Delete**.
2. Validate **logs** and **files** (vault + Dropbox agree).

**Expected**

- **D:** `deleteLocal` + `deleteLocalFolder` in the same cycle; `_runbooks/` gone locally (no empty shell left for a second sync).

---

## Pass 5 — E (coalesce blocked by extra remote member)

Requires a restored `_seeds/bulk/` (reseed / copy back + Sync Now) before this pass.

### E — Extra remote file blocks recursive coalesce

1. On Dropbox web, create `_seeds/bulk/extra-remote-only.md` with a short unique sentence (do not create it locally).
2. Locally delete the entire `_seeds/bulk/` folder again (`bulk-01.md` … `bulk-50.md` and the folder). Leave no local `extra-remote-only.md`.

### Sync and validate (Pass 5)

1. Sync Now once → Deletions modal → click **Delete**.
2. Validate **logs** and **files**.

**Expected**

- **E:** Coalesce falls back to per-file deletes / refuses recursive delete of unverified members (R14); mismatch logs may include `liveOnly` / `liveFolders`; do not silently wipe the extra remote member without it being in the delete set.
