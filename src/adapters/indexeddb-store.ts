import localforage from "localforage";
import type { SyncStateStore } from "./interfaces";
import type { SyncEntry } from "../types";

const ENTRIES_STORE = "sync-entries";
const META_STORE = "sync-meta";
const DB_NAME_PREFIX = "dropbox-sync-";

/** IndexedDB database name for a persisted vaultInstanceId. */
export function indexedDbNameForVaultInstance(vaultInstanceId: string): string {
  return `${DB_NAME_PREFIX}${vaultInstanceId}`;
}

/**
 * Pre-vaultInstanceId naming used vault.getName() (folder basename). Kept only
 * so we can copy sync state once into the instance-id database.
 */
export function legacyIndexedDbNameForVaultFolder(vaultFolderName: string): string {
  return `${DB_NAME_PREFIX}${vaultFolderName}`;
}

function createStorePair(dbName: string): { entries: LocalForage; meta: LocalForage } {
  return {
    entries: localforage.createInstance({ name: dbName, storeName: ENTRIES_STORE }),
    meta: localforage.createInstance({ name: dbName, storeName: META_STORE }),
  };
}

async function storePairHasData(pair: { entries: LocalForage; meta: LocalForage }): Promise<boolean> {
  const entryKeys = await pair.entries.keys();
  if (entryKeys.length > 0) return true;
  const metaKeys = await pair.meta.keys();
  return metaKeys.length > 0;
}

async function copyStorePair(
  from: { entries: LocalForage; meta: LocalForage },
  to: { entries: LocalForage; meta: LocalForage },
): Promise<void> {
  const entryCopies: Promise<unknown>[] = [];
  await from.entries.iterate<SyncEntry, void>((value, key) => {
    entryCopies.push(to.entries.setItem(key, value));
  });
  await Promise.all(entryCopies);

  const metaCopies: Promise<unknown>[] = [];
  await from.meta.iterate<string, void>((value, key) => {
    metaCopies.push(to.meta.setItem(key, value));
  });
  await Promise.all(metaCopies);
}

/**
 * One-time move from dropbox-sync-<vaultFolderName> → dropbox-sync-<vaultInstanceId>
 * when the new DB is empty and the legacy DB has data. Clears legacy after copy so
 * same-named vaults no longer share leftover state.
 *
 * @returns true if a migration ran
 */
export async function migrateLegacyIndexedDbIfNeeded(
  vaultInstanceId: string,
  legacyVaultFolderName: string,
): Promise<boolean> {
  if (!vaultInstanceId || !legacyVaultFolderName) return false;
  const newName = indexedDbNameForVaultInstance(vaultInstanceId);
  const legacyName = legacyIndexedDbNameForVaultFolder(legacyVaultFolderName);
  if (newName === legacyName) return false;

  const next = createStorePair(newName);
  if (await storePairHasData(next)) return false;

  const legacy = createStorePair(legacyName);
  if (!(await storePairHasData(legacy))) return false;

  await copyStorePair(legacy, next);
  await legacy.entries.clear();
  await legacy.meta.clear();
  return true;
}

/**
 * IndexedDB 기반 SyncStateStore (localforage 래퍼).
 *
 * DB name uses persisted vaultInstanceId (not vault folder name) so two vaults
 * with the same basename do not share sync history on one machine.
 * iOS에서 IndexedDB 불안정 시 file-store fallback 사용 (Phase 2.5).
 */
export class IndexedDBStore implements SyncStateStore {
  private entriesDb: LocalForage;
  private metaDb: LocalForage;

  constructor(vaultInstanceId: string) {
    const pair = createStorePair(indexedDbNameForVaultInstance(vaultInstanceId));
    this.entriesDb = pair.entries;
    this.metaDb = pair.meta;
  }

  async getEntry(pathLower: string): Promise<SyncEntry | null> {
    return this.entriesDb.getItem<SyncEntry>(pathLower);
  }

  async setEntry(entry: SyncEntry): Promise<void> {
    await this.entriesDb.setItem(entry.pathLower, entry);
  }

  async deleteEntry(pathLower: string): Promise<void> {
    await this.entriesDb.removeItem(pathLower);
  }

  async getAllEntries(): Promise<SyncEntry[]> {
    const entries: SyncEntry[] = [];
    await this.entriesDb.iterate<SyncEntry, void>((value) => {
      entries.push(value);
    });
    return entries;
  }

  async clear(): Promise<void> {
    await this.entriesDb.clear();
    await this.metaDb.clear();
  }

  async getMeta(key: string): Promise<string | null> {
    return this.metaDb.getItem<string>(key);
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.metaDb.setItem(key, value);
  }
}
