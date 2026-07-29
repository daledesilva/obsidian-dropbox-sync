# 06 — Renaming and moving

## Setup

1. Sync Now so `_seeds/` matches Dropbox.
2. Prefer Sync Now once after each pass below (do not Sync Now between steps inside a pass).

---

## Pass 1 — A, B, C, D (one Sync Now)

Apply **all** of the following local changes in Obsidian **before** Sync Now. Do not sync between them.

### A — Simple file rename (G7)

1. Rename `_seeds/notes/rename-me.md` → `_seeds/notes/renamed.md`.



### B — Simple file move (G7)

1. Move `_seeds/folders/nested/deep-note.md` → `_seeds/folders/deep-note.md`.



### C — Intact populated folder rename (G8)

1. Rename `_seeds/case` → `_seeds/case-renamed` (leave `Note.md` inside at `_seeds/case-renamed/Note.md`).



### D — Intact populated folder move (G8)

1. Move `_seeds/binaries` → `_seeds/bulk/binaries` (leave inner files unchanged).

After A–D, local tree should include at least:

- `_seeds/notes/renamed.md`
- `_seeds/folders/deep-note.md`
- `_seeds/folders/nested/` (empty leftover after B — leave it)
- `_seeds/case-renamed/Note.md`
- `_seeds/bulk/binaries/` (with the former binaries contents)
- `_seeds/folders/empty-keep/.keep.md` (untouched)
- `_seeds/exclude-bait/` (untouched)



### Sync and validate (Pass 1)

1. Sync Now once.
2. Validate **logs** and **files** (vault + Dropbox agree).

**Expected**

- **A:** Prefer `moveRemote` for the note; rename chip (`Aa`); no stale `rename-me.md` on Dropbox.
- **B:** Prefer `moveRemote` to `_seeds/folders/deep-note.md`; move chip; content unchanged.
- **C:** Prefer `moveRemoteFolder` for `_seeds/case` → `_seeds/case-renamed`; children travel with the folder; rename chip.
- **D:** Prefer `moveRemoteFolder` for `_seeds/binaries` → `_seeds/bulk/binaries`; move chip; no mass re-upload of every child when detection succeeds.
- End state paths match the local tree above; no silent data loss; no conflict copies when only paths changed.

---



## Pass 2 — E, F, G, H (one Sync Now)

Paths below assume Pass 1 succeeded. Apply **all** of the following local changes in Obsidian **before** Sync Now. Do not sync between them.

Doing **E and F in the same cycle** is intentional: renaming `notes` while also renaming a file inside it forces the compound folder+inner path (create+file-moves fallback is OK).

### E — Sibling folder renames (G8)

1. Rename `_seeds/bulk` → `_seeds/bulk-renamed` (leave relative file names inside unchanged).
2. Rename `_seeds/exclude-bait` → `_seeds/exclude-bait-renamed` (leave relative file names inside unchanged).
3. Rename `_seeds/notes` → `_seeds/notes-renamed` (after F’s inner file rename below, or do F first then this rename — both before Sync Now).



### F — Folder rename + inner file rename (same cycle) — fallback OK

1. Rename `_seeds/notes/baseline.md` → `_seeds/notes/baseline-renamed.md`.
2. Then ensure the folder rename from E is applied: `_seeds/notes` → `_seeds/notes-renamed` so the file ends at `_seeds/notes-renamed/baseline-renamed.md`.



### G — Empty-keep folder rename — fallback OK

1. Rename `_seeds/folders/empty-keep` → `_seeds/folders/empty-keep-renamed`.



### H — Parent rename + child moved out (compound) — fallback OK

1. Move `_seeds/case-renamed/Note.md` → `_seeds/Note.md`.
2. Rename `_seeds/case-renamed` → `_seeds/case-renamed-again`.

After E–H, local tree should include at least:

- `_seeds/notes-renamed/baseline-renamed.md`
- `_seeds/notes-renamed/renamed.md`
- `_seeds/bulk-renamed/binaries/`
- `_seeds/exclude-bait-renamed/`
- `_seeds/folders/empty-keep-renamed/` (with former `empty-keep` contents)
- `_seeds/Note.md`
- `_seeds/case-renamed-again/` (vacated of `Note.md`)
- `_seeds/folders/deep-note.md` (unchanged from Pass 1)



### Sync and validate (Pass 2)

1. Sync Now once.
2. Validate **logs** and **files** (vault + Dropbox agree).
3. If chips show failures with `too_many_write_operations` / rate limit: wait briefly, Sync Now again — that is expected under many parallel moves, not a detection bug.

**Expected**

- **E:** Prefer folder moves for intact siblings (`bulk` → `bulk-renamed`, `exclude-bait` → `exclude-bait-renamed`). `notes` → `notes-renamed` may **not** be one `moveRemoteFolder` when F also renames an inner file in the same cycle — create folder + per-file `moveRemote` (or create+delete) is accepted.
- **F:** Not required to be one compound `moveRemoteFolder`. Accepted: `createRemoteFolder` for `_seeds/notes-renamed` plus G7 `moveRemote` for unique-hash files (including `baseline.md` → `baseline-renamed.md`); upload/delete chips are fine. End state: content under `_seeds/notes-renamed/`; no silent loss.
- **G:** No invented folder move required — `createRemoteFolder` + `deleteRemoteFolder` (or equivalent) is accepted. End state: `_seeds/folders/empty-keep-renamed/` on both sides; no leftover `_seeds/folders/empty-keep/`.
- **H:** Detection may fall back to create+delete for vacated shells. Prefer `moveRemote` for `_seeds/case-renamed/Note.md` → `_seeds/Note.md`, then create/rename for `_seeds/case-renamed-again` and delete vacated `_seeds/case-renamed`. Must not false-pair a small folder onto a larger renamed parent. End state: `_seeds/Note.md` present; `_seeds/case-renamed-again/` present without `Note.md`.
- **Rate limits:** A failed chip count for `moveRemote` with `DropboxRateLimitError` / `too_many_write_operations` is a **real** executor failure (not a false chip). Retry Sync Now; local files should still be present and will finish moving/uploading.

