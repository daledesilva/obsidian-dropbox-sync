# Sync scenario runbooks

Walk one runbook at a time. Full matrices live in the repo: `docs/sync-scenarios.md`.

| # | Runbook | Scenario section | Needs remote wipe before reset? |
|---|---------|------------------|----------------------------------|
| 01 | [Basic operations](01-basic-operations.md) | §1, §2, §4 simple, §7, §8, §9 simple | Usually no |
| 02 | [Renaming and moving](02-renaming-and-moving.md) | §6 | **Yes** |
| 03 | [Delete protection](03-delete-protection.md) | §4 advanced / §9 R14 | **Yes** |
| 04 | [Delete edge cases](04-delete-edge-cases.md) | §5, §11 | **Yes** |
| 05 | [File size and content type](05-file-size-and-content-type.md) | §12 | Usually no |
| 06 | [Interruptions](06-interruptions.md) | §13 | Depends |
| 07 | [Joining or rejoining](07-joining-or-rejoining.md) | §10 | **Yes** — start with `bun run qa:empty` |
| 08 | [Simultaneous editing](08-simultaneous-editing.md) | §3 | **Yes** (conflict copies) |

**Before each runbook:** Sync Now so `_seeds/` matches Dropbox (or reseed + remote wipe if the last scenario polluted state). Maintainer format and runbook-dependent log contract: repo `docs/qa-runbooks.md`.

**Peer for two-device rows:** Dropbox web (or another machine). This harness is one desktop vault.
