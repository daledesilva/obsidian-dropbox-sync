# 10 — Joining or rejoining

## Setup

1. Prefer a throwaway Dropbox folder link for this runbook (destructive to local sync state).
2. Prefer Sync Now once after each pass below (do not Sync Now between steps inside a pass).
3. Open an empty local vault from the plugin repo (wipe auth + sync state, no `_seeds/` fixtures):

```bash
bun run qa:empty
```

This is **not** `qa:restart` — restart reseeds fixtures. Join leaves the vault empty of those files (runbooks + plugin only). Does **not** wipe Dropbox — clear the linked remote folder in Dropbox web when you need an empty peer.

Optional: `QA_WITH_SEEDS=1 bun run qa:empty` regenerates `_seeds/` for upload-ask checks against an empty remote.

---

## Pass 1 — A (one Sync Now)

### A — Fresh join against populated remote

1. Run `bun run qa:empty` (or confirm the empty vault is open).
2. Complete OAuth; link the Dropbox folder under test (peer already has content).

### Sync and validate (Pass 1)

1. Sync Now once.
2. Validate **logs** and **files** (vault + Dropbox agree).

**Expected**

- **A:** Download of remote files; not a mass upload of emptiness as deletes without asking (R11 / join rules). Identical hashes converge without conflict spam. For R6 upload-ask against a wiped remote, use `QA_WITH_SEEDS=1` or add local files yourself first.

---

## Pass 2 — B (one Sync Now)

### B — Re-link to a different folder

1. In settings, change the linked Dropbox folder to a different folder (empty or other).

### Sync and validate (Pass 2)

1. Sync Now once (or complete the re-link prompt flow, then Sync Now).
2. Validate **logs** and **files**.

**Expected**

- **B:** Explicit re-link / intent prompt (R11) — **not** a silent mass delete of local files or mass wipe of the new remote; no unprompted mass `deleteLocal` / `deleteRemote` after the folder change; cursor/folder-identity reset behaviour if implemented (G28).
