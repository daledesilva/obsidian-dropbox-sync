import type {
  FileInfo,
  RemoteEntry,
  SyncEntry,
  ListChangesResult,
  DownloadResult,
} from "../types";

/** Options for {@link FileSystem.list}. */
export interface FileListOptions {
  configDir: string;
  /** Adapter-scan configDir when settings/plugins/workspaces are in sync scope. */
  configDiskScan?: boolean;
  /** Adapter-scan vault root for hidden/dot paths (user setting). */
  includeHiddenFilesAndFolders?: boolean;
}

/** 로컬 파일시스템 추상화 */
export interface FileSystem {
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array, mtime?: number): Promise<void>;
  delete(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  list(options?: FileListOptions): Promise<FileInfo[]>;
  stat(path: string): Promise<{ mtime: number; size: number }>;
  computeHash(path: string): Promise<string>;
}

/** Per-path result from {@link RemoteStorage.deleteBatch}. */
export interface RemoteDeleteBatchEntryResult {
  path: string;
  ok: boolean;
  error?: Error;
  /**
   * Dropbox `too_many_files` on a folder entry — executor should expand to
   * covered file paths and re-batch those files.
   */
  tooManyFiles?: boolean;
}

/**
 * Live file under a folder from {@link RemoteStorage.listFilePathLowersUnder}.
 * Used to verify folder deletes against Dropbox before recursive delete_batch.
 */
export interface RemoteListedFile {
  pathLower: string;
  contentHash: string;
}

/** 원격 스토리지 추상화 (Dropbox) */
export interface RemoteStorage {
  listChanges(cursor?: string): Promise<ListChangesResult>;
  download(path: string): Promise<DownloadResult>;
  upload(
    path: string,
    data: Uint8Array,
    rev?: string,
  ): Promise<RemoteEntry>;
  delete(path: string): Promise<void>;
  /**
   * Delete many files/folders in one or more batch RPCs.
   * Paths are vault-relative (same as {@link delete}). Results match input order.
   * Folder paths recursively delete contents on Dropbox.
   */
  deleteBatch(paths: string[]): Promise<RemoteDeleteBatchEntryResult[]>;
  /**
   * Live-list non-deleted files under a vault-relative folder (recursive).
   * Folder-delete coalesce requires this set to exactly match the planned deletes.
   */
  listFilePathLowersUnder(folderPath: string): Promise<RemoteListedFile[]>;
  move(from: string, to: string): Promise<RemoteEntry>;
}

/** 동기화 상태 저장소 추상화 */
export interface SyncStateStore {
  getEntry(pathLower: string): Promise<SyncEntry | null>;
  setEntry(entry: SyncEntry): Promise<void>;
  deleteEntry(pathLower: string): Promise<void>;
  getAllEntries(): Promise<SyncEntry[]>;
  clear(): Promise<void>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
}
