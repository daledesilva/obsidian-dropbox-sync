# 09 — Folders containing files

## Setup

1. Sync Now so `_seeds/bulk/` and `_seeds/folders/nested/` match Dropbox.
2. Prefer Sync Now once after each pass below (do not Sync Now between steps inside a pass).
3. Delete protection on; threshold at default (5).

---

## Pass 1 — A (one Sync Now)

### A — Delete entire bulk folder locally

1. Delete the entire `_seeds/bulk/` folder in Obsidian (all of `_seeds/bulk/bulk-01.md` … `_seeds/bulk/bulk-50.md` and the folder itself).

After A, local tree should include at least:

- no `_seeds/bulk/`
- `_seeds/folders/nested/deep-note.md` (untouched)

### Sync and validate (Pass 1)

1. Sync Now once — expect Deletions modal (count exceeds threshold).
2. Click **Delete**.
3. Validate **logs** and **files** (vault + Dropbox agree).

**Expected**

- **A:** Mass-delete confirm (R9); after Approve, `_seeds/bulk/` gone on Dropbox; prefer coalesced folder delete when membership matches (R14); `deleteRemoteFolder` or `inferred_local_tree_wipe` — not `createLocalFolder` / `folder_restored` for the same path in that cycle; exec verify `folderPaths > 0` when membership matches.

---

## Pass 2 — B (coalesce blocked by extra remote member)

Requires a restored `_seeds/bulk/` (reseed / copy back + Sync Now) before this pass.

### B — Extra remote file blocks recursive coalesce

1. On Dropbox web, create `_seeds/bulk/extra-remote-only.md` with a short unique sentence (do not create it locally).
2. Locally delete the entire `_seeds/bulk/` folder again (`bulk-01.md` … `bulk-50.md` and the folder). Leave no local `extra-remote-only.md`.

### Sync and validate (Pass 2)

1. Sync Now once → Deletions modal → click **Delete**.
2. Validate **logs** and **files**.

**Expected**

- **B:** Coalesce falls back to per-file deletes / refuses recursive delete of unverified members (R14); mismatch logs may include `liveOnly` / `liveFolders`; do not silently wipe the extra remote member without it being in the delete set.
