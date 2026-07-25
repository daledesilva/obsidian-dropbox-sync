# Plugin persistence and sync state

## Why it exists

The plugin keeps several kinds of data in different places on purpose: OAuth and preferences must travel with the vault’s plugin settings, sync history must stay **per device**, and Cursor Debug host fields must stay **per machine** so one device’s LAN IP is not written into another device’s `data.json`. Knowing where each piece lives is required for upgrades, resets during testing, and avoiding vault-name collisions on desktop IndexedDB.

## Conceptual understanding

| Kind of data | Where | Syncs with vault / Dropbox? |
|---|---|---|
| Settings, OAuth, `deviceId`, `vaultInstanceId` | `.obsidian/plugins/dropbox-sync/data.json` via `loadData` / `saveData` | Yes, if that plugin folder is in sync scope |
| Sync base, Dropbox cursor, delete log | IndexedDB `dropbox-sync-<vaultInstanceId>` (desktop/Android); vault `.sync-state/` on iOS | No (device-local). `.sync-state/` is exclude-listed |
| Cursor Debug host / port / session / path / server name / offer token | `App.loadLocalStorage` / `App.saveLocalStorage` key `dropbox-sync-device-settings_v1` (filled by Connect; cleared when Debug logging turns off) | No — vault-namespaced on this Obsidian profile |
| User-facing debug log | Vault root `sync-debug-<deviceId>.log` | Can sync like any vault file (intentional — users open/share it) |

`vaultInstanceId` is a UUID minted once and stored in `data.json`. It names the IndexedDB database. It is **not** the Dropbox remote folder name (`syncName`) and **not** the short `deviceId` used in log filenames.

```mermaid
flowchart TB
  subgraph vaultFiles [Vault files]
    DataJson["data.json settings + vaultInstanceId"]
    SyncDebug["sync-debug-*.log"]
    SyncStateIos[".sync-state/ on iOS only"]
  end
  subgraph deviceLocal [This machine only]
    Idb["IndexedDB dropbox-sync-vaultInstanceId"]
    AppLs["App localStorage device-settings blob"]
  end
  DataJson --> Idb
  AppLs --> Ingest["Cursor Debug ingest URL"]
  SyncDebug --> User["User View logs / share"]
```

## Flows

### Fresh install / first load

1. `initDeviceSettings(app)` binds App localStorage and may copy a legacy raw-`localStorage` blob into vault-scoped storage.
2. Settings load; if `vaultInstanceId` is empty, mint a UUID and save.
3. Non‑iOS: if IndexedDB for the new id is empty and legacy `dropbox-sync-<vaultFolderName>` has data, copy entries/meta then clear the legacy DB (**before** `saveSettings` → background sync can start).
4. Engine deps open `IndexedDBStore(vaultInstanceId)` or `VaultFileStore` on iOS.

### Resetting sync history (testing “brand new plugin”)

Goal: empty vault should **re-download** from Dropbox instead of pushing local deletes.

**Preferred:** Settings → Dropbox Sync → Troubleshooting → **Clear sync history** (confirm). That clears only the sync store and in-memory delete log on this device. It does **not** clear Debug logging, Cursor Debug ingest fields, OAuth, debug log files, or vault/Dropbox files.

Manual alternative (if the UI is unavailable):

1. Disable or pause sync / quit Obsidian if needed.
2. Clear sync state only:
   - Desktop/Android: delete IndexedDB `dropbox-sync-<vaultInstanceId>` (id is in `data.json`).
   - iOS: clear or delete `.sync-state/entries.json` and `.sync-state/meta.json`.
3. Optionally delete `sync-debug-*.log` for a clean log; not required for planner behavior.
4. Leave `data.json` alone to keep OAuth (unless you also want to re-auth).
5. Reload the plugin, then sync with an empty local vault.

Do **not** rely on `resetEngine()` — that rebuilds the engine and preserves the delete log; it does not wipe IndexedDB. Clear history is refused while a sync is running.

### Device-settings migrate (Cursor Debug fields)

Older builds stored the blob in raw `window.localStorage` (global across vaults). On init, if App storage is empty, that legacy JSON is copied into `App.saveLocalStorage`. The next write clears the legacy key.

## Technical details

| Module | Role |
|---|---|
| `src/settings.ts` | `vaultInstanceId`, `generateVaultInstanceId()` |
| `src/adapters/indexeddb-store.ts` | DB naming helpers, `migrateLegacyIndexedDbIfNeeded`, `IndexedDBStore` |
| `src/adapters/vault-file-store.ts` | iOS sync-state files under `.sync-state/` |
| `src/device-settings/` | App-scoped device blob; `initDeviceSettings` in `onload` |
| `src/log-manager.ts` + `main.ts` logger path | Vault-root `sync-debug-*.log` (user-visible by design) |
| `EngineManager.clearSyncHistory` / `main.clearSyncHistory` | UI **Clear sync history** — `store.clear()` + empty delete log; drop engine so intents are not rehydrated |
| `.cursor/rules/device-local-settings.mdc` | Prefer App localStorage over raw `window.localStorage` |

Built-in exclude patterns include `.sync-state/` so the iOS fallback does not round-trip through Dropbox.

## Technical Gotchas

- **Never key IndexedDB with `vault.getName()`.** Folder basenames collide; desktop IndexedDB is shared per Obsidian origin, so two vaults named `Notes` would share sync history.
- **Migrate legacy IDB before `saveSettings` on first mint.** `saveSettings` → `applySyncState` can schedule background sync; an empty new DB before copy would look like a fresh vault and can push deletes.
- **`vaultInstanceId` in `data.json` can sync across devices** if the plugin folder is synced. That is fine for naming: each machine still has its own IndexedDB. Wiping `data.json` mints a new id and orphans the old DB on that machine.
- **Vault-root debug logs are intentional.** Do not move them under `.obsidian/plugins` for “correctness”; users rely on seeing them in the vault and in View logs.
- **App localStorage is vault-namespaced.** After migration from the old global key, Cursor Debug host/session are per vault on this profile — re-enter values in another vault if needed.
- **Debug logging OFF clears ingest connection fields.** Host/path/session/token/server name are wiped from the device blob so a later session does not POST to a stale Cursor ingest path; quitting Obsidian with Debug still on keeps the cache.
- **iOS Lockdown Mode** can break IndexedDB persistence in Obsidian generally; this plugin already falls back to `.sync-state/` on iOS.
