# Sync scenario runbooks

Walk one runbook at a time. Full matrices live in the repo: `docs/sync-scenarios.md`.

| # | Runbook | Scenario section | Needs remote wipe before reset? |
|---|---------|------------------|----------------------------------|
| 01 | [Creating a file](01-creating-a-file.md) | §1 | Usually no |
| 02 | [Modifying a file](02-modifying-a-file.md) | §2 | Usually no |
| 03 | [Simultaneous editing](03-simultaneous-editing.md) | §3 | **Yes** (conflict copies) |
| 04 | [Deleting a file](04-deleting-a-file.md) | §4 | **Yes** |
| 05 | [Delete crossed with edit](05-delete-crossed-with-edit.md) | §5 | **Yes** |
| 06 | [Renaming and moving](06-renaming-and-moving.md) | §6 | **Yes** |
| 07 | [Capitalisation](07-capitalisation.md) | §7 | **Yes** |
| 08 | [Folders and empty folders](08-folders-and-empty-folders.md) | §8 | **Yes** |
| 09 | [Folders containing files](09-folders-containing-files.md) | §9 | **Yes** |
| 10 | [Joining or rejoining](10-joining-or-rejoining.md) | §10 | **Yes** — start with `bun run qa:empty` |
| 11 | [Deletes a device never saw](11-deletes-device-never-saw.md) | §11 | **Yes** |
| 12 | [File size and content type](12-file-size-and-content-type.md) | §12 | Usually no |
| 13 | [Interruptions](13-interruptions.md) | §13 | Depends |

**Before each runbook:** Sync Now so `_seeds/` matches Dropbox (or reseed + remote wipe if the last scenario polluted state).

**Peer for two-device rows:** Dropbox web (or another machine). This harness is one desktop vault.
