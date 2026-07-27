# 10 — Joining or rejoining

**Scenario:** `docs/sync-scenarios.md` §10  
**Remote wipe before reset:** yes (if you clear state)

## Setup

Destructive to local sync state. Prefer a throwaway Dropbox folder link for this runbook.

From the plugin repo, open an **empty local vault** (wipe auth + sync state, no `_seeds/` fixtures, rebuild plugin, launch sandboxed Obsidian):

```bash
bun run qa:empty
```

This is **not** `qa:restart` — restart reseeds the test fixtures. Join wipes and leaves the vault empty of those files (runbooks + plugin only). **Does not wipe Dropbox** — clear the linked remote folder in Dropbox web when you need an empty peer.

Optional: `QA_WITH_SEEDS=1 bun run qa:empty` regenerates `_seeds/` for upload-ask checks against an empty remote.

## Steps

### Fresh join

1. Run `bun run qa:empty`.
2. Complete OAuth on the empty vault; link the Dropbox folder under test.
3. Sync Now.
4. Expect download of remote files when the peer already has content — not a mass upload of emptiness as “deletes” without asking (R11 / join rules). For R6 upload-ask, either add local files yourself or use `QA_WITH_SEEDS=1` against a wiped remote.

### Re-link (R11)

1. Change the linked Dropbox folder to a different (empty or other) folder in settings.
2. Expect an explicit re-link / intent prompt — **not** a silent mass delete of local files or mass wipe of the new remote.

## Expected

- Join downloads remote; identical content converges without conflict spam when hashes match.
- Re-link asks; never infers mass deletion solely from “everything missing on the other side” after a folder change (R11).

## Log signals

- Re-link / folder-identity prompt.
- Absence of unprompted mass deleteLocal / deleteRemote after link change.
- Full list_folder / cursor reset behaviour if implemented (G28).
