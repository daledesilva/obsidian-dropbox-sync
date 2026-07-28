import { dropboxContentHash } from "../hash";
import { DropboxCursorResetError } from "./dropbox-adapter";
import {
  RevConflictError,
  type FileInfo,
  type RemoteEntry,
  type SyncEntry,
  type ListChangesResult,
  type DownloadResult,
} from "../types";
import type {
  FileListOptions,
  FileSystem,
  RemoteDeleteBatchEntryResult,
  RemoteListedFile,
  RemoteRevision,
  RemoteStorage,
  SyncStateStore,
} from "./interfaces";
import type { FolderInfo } from "../types";

// re-export for backward compat
export { RevConflictError };

// ── MemoryFileSystem ──

interface MemoryFile {
  data: Uint8Array;
  mtime: number;
}

/** Positive scan-completeness signal for delete inference (G22) — mirrors VaultAdapter. */
export interface MemoryScanCompleteness {
  vouched: boolean;
  listErrors: string[];
}

export class MemoryFileSystem implements FileSystem {
  private files = new Map<string, MemoryFile>();
  /** Explicit empty folders (G8). */
  private folders = new Set<string>();
  /**
   * Engine gates inferMissingDeletes on vouched (G22). Defaults true; tests can
   * call {@link setScanCompleteness} to simulate an incomplete local scan.
   */
  lastScanCompleteness: MemoryScanCompleteness = { vouched: true, listErrors: [] };

  // eslint-disable-next-line @typescript-eslint/require-await -- async wraps sync throw into rejection
  async read(path: string): Promise<Uint8Array> {
    const file = this.files.get(path);
    if (!file) throw new Error(`File not found: ${path}`);
    return file.data;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- sync-only implementation
  async write(path: string, data: Uint8Array, mtime?: number): Promise<void> {
    const tempPath = `${path}.tmp-dropbox-sync`;
    this.files.set(tempPath, { data, mtime: mtime ?? Date.now() });
    this.files.delete(path);
    this.files.set(path, this.files.get(tempPath)!);
    this.files.delete(tempPath);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async wraps sync throw into rejection
  async delete(path: string): Promise<void> {
    if (!this.files.has(path)) throw new Error(`File not found: ${path}`);
    this.files.delete(path);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- sync-only implementation
  async rename(from: string, to: string): Promise<void> {
    const file = this.files.get(from);
    if (!file) throw new Error(`File not found: ${from}`);
    this.files.delete(from);
    this.files.set(to, file);
  }

  /**
   * Rename an empty/folder marker and rewrite child file + nested folder prefixes.
   * Used by scenario-matrix folder move/rename rows (G7/G8).
   */
  async renameFolder(from: string, to: string): Promise<void> {
    const fromNorm = from.replace(/\/+$/, "");
    const toNorm = to.replace(/\/+$/, "");
    const fromPrefix = `${fromNorm}/`;
    const toPrefix = `${toNorm}/`;

    if (this.folders.has(fromNorm)) {
      this.folders.delete(fromNorm);
      this.folders.add(toNorm);
    }
    for (const folderPath of [...this.folders]) {
      if (folderPath === fromNorm) continue;
      if (folderPath.startsWith(fromPrefix) || folderPath.toLowerCase().startsWith(fromPrefix.toLowerCase())) {
        this.folders.delete(folderPath);
        const suffix = folderPath.slice(fromNorm.length);
        this.folders.add(`${toNorm}${suffix}`);
      }
    }
    for (const filePath of [...this.files.keys()]) {
      if (filePath === fromNorm || filePath.startsWith(fromPrefix)
        || filePath.toLowerCase().startsWith(fromPrefix.toLowerCase())) {
        const file = this.files.get(filePath)!;
        this.files.delete(filePath);
        const suffix = filePath.slice(fromNorm.length);
        this.files.set(`${toNorm}${suffix}`, file);
      }
    }
    // Ensure destination folder marker exists even when only children moved.
    this.folders.add(toNorm);
  }

  /** Test helper: mark the next list() as incomplete so inferred deletes defer (G22). */
  setScanCompleteness(completeness: MemoryScanCompleteness): void {
    this.lastScanCompleteness = completeness;
  }

  async list(_options?: FileListOptions): Promise<FileInfo[]> {
    const result: FileInfo[] = [];
    for (const [path, file] of this.files) {
      result.push({
        path,
        pathLower: path.toLowerCase(),
        hash: await dropboxContentHash(file.data),
        mtime: file.mtime,
        size: file.data.length,
      });
    }
    return result;
  }

  async listFolders(_options?: FileListOptions): Promise<FolderInfo[]> {
    const folderPaths = new Set<string>(this.folders);
    for (const path of this.files.keys()) {
      const parts = path.split("/");
      let current = "";
      for (let i = 0; i < parts.length - 1; i++) {
        current = current ? `${current}/${parts[i]}` : parts[i]!;
        folderPaths.add(current);
      }
    }
    return [...folderPaths].sort().map((path) => ({
      path,
      pathLower: path.toLowerCase(),
    }));
  }

  async createFolder(path: string): Promise<void> {
    this.folders.add(path);
  }

  async deleteFolder(path: string): Promise<void> {
    this.folders.delete(path);
    const prefix = `${path}/`;
    for (const filePath of [...this.files.keys()]) {
      if (filePath.startsWith(prefix) || filePath.toLowerCase().startsWith(prefix.toLowerCase())) {
        this.files.delete(filePath);
      }
    }
    for (const folderPath of [...this.folders]) {
      if (folderPath.toLowerCase().startsWith(prefix.toLowerCase())) {
        this.folders.delete(folderPath);
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async wraps sync throw into rejection
  async stat(path: string): Promise<{ mtime: number; size: number }> {
    const file = this.files.get(path);
    if (!file) throw new Error(`File not found: ${path}`);
    return { mtime: file.mtime, size: file.data.length };
  }

  async computeHash(path: string): Promise<string> {
    const file = this.files.get(path);
    if (!file) throw new Error(`File not found: ${path}`);
    return dropboxContentHash(file.data);
  }

  // 테스트 헬퍼
  has(path: string): boolean {
    return this.files.has(path);
  }

  /** 파일명이 prefix로 시작하는 첫 번째 경로 반환 */
  findByPrefix(prefix: string): string | undefined {
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) return key;
    }
    return undefined;
  }

  getData(path: string): Uint8Array | undefined {
    return this.files.get(path)?.data;
  }

  getFileCount(): number {
    return this.files.size;
  }
}

// ── MemoryRemoteStorage ──

interface RemoteFile {
  pathLower: string;
  pathDisplay: string;
  data: Uint8Array;
  hash: string;
  rev: string;
  serverModified: number;
  clientModified?: number;
  deleted: boolean;
}

/** 변경 이력 엔트리 (cursor 시뮬레이션용) */
interface ChangeLogEntry {
  entry: RemoteEntry;
  seq: number;
}

export class MemoryRemoteStorage implements RemoteStorage {
  /** Test helper: number of deleteBatch invocations. */
  deleteBatchCallCount = 0;
  /** Test helper: paths passed to the last deleteBatch call. */
  lastDeleteBatchPaths: string[] = [];
  /**
   * When set, {@link listChanges} paginates at this many entries per page.
   * Lets simulation tests exercise hasMore cursor advancement.
   */
  pageSize: number | null = null;
  private files = new Map<string, RemoteFile>();
  private changeLog: ChangeLogEntry[] = [];
  private revisionHistory = new Map<string, RemoteRevision[]>();
  /**
   * Empty-folder simulation: key = path_lower with trailing slash, value = display path.
   * Display casing must be preserved — lowercasing pathDisplay caused false case-only
   * moveRemoteFolder plans when the vault still held `Projects/`.
   */
  private folders = new Map<string, string>();
  private seq = 0;
  private revCounter = 0;
  private cursorInvalidated = false;

  // eslint-disable-next-line @typescript-eslint/require-await -- sync-only implementation
  async listChanges(cursor?: string): Promise<ListChangesResult> {
    if (
      this.cursorInvalidated &&
      cursor !== undefined &&
      cursor !== "" &&
      cursor !== "0"
    ) {
      throw new DropboxCursorResetError("Cursor reset required");
    }

    const fromSeq = cursor ? parseInt(cursor, 10) : 0;
    const pending = this.changeLog.filter((c) => c.seq > fromSeq);
    const limit = this.pageSize ?? pending.length;
    const page = pending.slice(0, limit);
    const folderEntries = this.buildFolderChangeEntries(fromSeq);
    const entries = [...page.map((c) => c.entry), ...folderEntries];
    const lastSeq = page.length > 0 ? page[page.length - 1].seq : this.seq;
    const hasMore = pending.length > page.length;

    if (this.cursorInvalidated && !cursor) {
      this.cursorInvalidated = false;
    }

    return {
      entries,
      cursor: String(lastSeq),
      hasMore,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async wraps sync throw into rejection
  async download(path: string): Promise<DownloadResult> {
    const pathLower = path.toLowerCase();
    const file = this.files.get(pathLower);
    if (!file || file.deleted) {
      throw new Error(`File not found on remote: ${path}`);
    }
    return {
      data: new Uint8Array(file.data),
      metadata: this.toRemoteEntry(file),
    };
  }

  async upload(
    path: string,
    data: Uint8Array,
    rev?: string,
    clientModified?: number,
  ): Promise<RemoteEntry> {
    const pathLower = path.toLowerCase();
    const existing = this.files.get(pathLower);

    // rev 기반 충돌 감지
    if (rev && existing && existing.rev !== rev) {
      throw new RevConflictError(
        `Rev conflict: expected ${rev}, got ${existing.rev}`,
        existing.rev,
      );
    }

    // G29: add-mode — path exists with different content → conflict, never overwrite.
    if (!rev && existing && !existing.deleted) {
      const newHash = await dropboxContentHash(data);
      if (existing.hash !== newHash) {
        throw new RevConflictError(
          `Path exists with different content: ${path}`,
          existing.rev,
        );
      }
      return this.toRemoteEntry(existing);
    }

    return this.writeRemoteFile(path, data, clientModified);
  }

  /**
   * Dropbox-desktop-client style overwrite for P3 peer simulation.
   * Plugin uploads must use {@link upload} (rev / add), never this.
   */
  async forceUpload(
    path: string,
    data: Uint8Array,
    clientModified?: number,
  ): Promise<RemoteEntry> {
    return this.writeRemoteFile(path, data, clientModified);
  }

  private async writeRemoteFile(
    path: string,
    data: Uint8Array,
    clientModified?: number,
  ): Promise<RemoteEntry> {
    const pathLower = path.toLowerCase();
    const newRev = this.nextRev();
    const hash = await dropboxContentHash(data);
    const now = Date.now();
    const modified = clientModified ?? now;

    const file: RemoteFile = {
      pathLower,
      pathDisplay: path,
      data: new Uint8Array(data),
      hash,
      rev: newRev,
      serverModified: now,
      clientModified: modified,
      deleted: false,
    };

    this.files.set(pathLower, file);
    this.addChangeLog(this.toRemoteEntry(file));
    this.appendRevision(pathLower, file);

    return this.toRemoteEntry(file);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- sync-only implementation
  async delete(path: string): Promise<void> {
    const pathLower = path.toLowerCase();
    const file = this.files.get(pathLower);
    if (file) {
      file.deleted = true;
      const deletedEntry = {
        ...this.toRemoteEntry(file),
        deleted: true,
        hash: null,
      };
      this.addChangeLog(deletedEntry);
      this.appendRevision(pathLower, {
        ...file,
        deleted: true,
        hash: file.hash,
      });
      return;
    }
    // Empty-folder delete (G8): remove tracked folder key + tombstone for peers.
    const folderKey = normalizeFolderPathLower(path);
    if (this.folders.has(folderKey)) {
      this.deleteFolder(path);
    }
  }

  /**
   * Test double for Dropbox delete_batch: exact file delete, or folder-prefix
   * delete when no exact file exists at the path.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- sync-only implementation
  async deleteBatch(paths: string[]): Promise<RemoteDeleteBatchEntryResult[]> {
    this.deleteBatchCallCount++;
    this.lastDeleteBatchPaths = [...paths];
    const results: RemoteDeleteBatchEntryResult[] = [];
    for (const path of paths) {
      const pathLower = path.toLowerCase();
      const exact = this.files.get(pathLower);
      if (exact && !exact.deleted) {
        await this.delete(path);
        results.push({ path, ok: true });
        continue;
      }
      // Folder (or already-absent) path: mark-delete every file under prefix.
      const prefix = pathLower.endsWith("/") ? pathLower : `${pathLower}/`;
      for (const [key, file] of this.files) {
        if (!file.deleted && key.startsWith(prefix)) {
          await this.delete(file.pathDisplay);
        }
      }
      // Match Dropbox soft-success: absent path is ok.
      results.push({ path, ok: true });
    }
    return results;
  }

  /**
   * Live children under folder for R14 verify. Includes nested files and empty
   * subfolders; never the folder path itself (self-membership breaks set equality).
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- sync-only implementation
  async listFilePathLowersUnder(folderPath: string): Promise<RemoteListedFile[]> {
    const folder = folderPath.toLowerCase().replace(/\/+$/, "");
    if (!folder) return [];
    const prefix = `${folder}/`;
    const listed: RemoteListedFile[] = [];
    for (const file of this.files.values()) {
      if (file.deleted) continue;
      if (file.pathLower.startsWith(prefix)) {
        listed.push({ pathLower: file.pathLower, contentHash: file.hash, isFolder: false });
      }
    }
    for (const folderKey of this.folders.keys()) {
      const normalized = folderKey.replace(/\/+$/, "").toLowerCase();
      // Exclude the folder being listed — only nested empty dirs belong in the live set.
      if (normalized !== folder && normalized.startsWith(prefix)) {
        listed.push({
          pathLower: normalized,
          contentHash: "",
          isFolder: true,
        });
      }
    }
    return listed;
  }

  async move(from: string, to: string): Promise<RemoteEntry> {
    const fromLower = from.toLowerCase();
    const toLower = to.toLowerCase();
    const file = this.files.get(fromLower);
    if (file && !file.deleted) {
      // Emit a deleted tombstone for the old path_lower so peer cursors see the rename
      // as delete+create (Dropbox move_v2 delta shape), not a silent key rewrite.
      if (fromLower !== toLower) {
        this.addChangeLog({
          pathLower: fromLower,
          pathDisplay: file.pathDisplay,
          hash: null,
          serverModified: Date.now(),
          rev: file.rev,
          size: 0,
          deleted: true,
        });
      }
      this.files.delete(fromLower);
      file.pathLower = toLower;
      file.pathDisplay = to;
      this.files.set(toLower, file);
      const entry = this.toRemoteEntry(file);
      this.addChangeLog(entry);
      this.appendRevision(toLower, file);
      return entry;
    }

    // Folder move (G8): relocate empty-folder marker + all children under prefix.
    const fromKey = normalizeFolderPathLower(from);
    const fromDisplay = from.replace(/\/+$/, "");
    const toDisplay = to.replace(/\/+$/, "");
    const fromPrefix = `${fromLower}/`;
    const hasFolder = this.folders.has(fromKey);
    const hasChildren = [...this.files.keys()].some((k) => k.startsWith(fromPrefix));
    if (!hasFolder && !hasChildren) {
      throw new Error(`File not found on remote: ${from}`);
    }
    if (fromLower !== toLower) {
      this.addChangeLog({
        pathLower: fromLower,
        pathDisplay: this.folders.get(fromKey) ?? fromDisplay,
        hash: null,
        serverModified: Date.now(),
        rev: "",
        size: 0,
        deleted: true,
        isFolder: true,
      });
    }
    this.folders.delete(fromKey);
    for (const [key, display] of [...this.folders.entries()]) {
      const normalized = key.replace(/\/+$/, "").toLowerCase();
      if (!normalized.startsWith(fromPrefix)) continue;
      this.folders.delete(key);
      const suffix = display.slice(fromDisplay.length);
      const childDisplay = `${toDisplay}${suffix}`;
      this.folders.set(normalizeFolderPathLower(childDisplay), childDisplay);
    }
    this.folders.set(normalizeFolderPathLower(toDisplay), toDisplay);
    for (const [key, child] of [...this.files.entries()]) {
      if (child.deleted) continue;
      if (key !== fromLower && !key.startsWith(fromPrefix)) continue;
      this.files.delete(key);
      const suffix = child.pathDisplay.slice(fromDisplay.length);
      const newDisplayPath = `${toDisplay}${suffix}`;
      child.pathLower = newDisplayPath.toLowerCase();
      child.pathDisplay = newDisplayPath;
      this.files.set(child.pathLower, child);
      this.addChangeLog(this.toRemoteEntry(child));
    }
    const folderEntry = this.folderToRemoteEntry(normalizeFolderPathLower(toDisplay), toDisplay);
    this.addChangeLog(folderEntry);
    return folderEntry;
  }

  async createFolder(path: string): Promise<RemoteEntry> {
    this.seedEmptyFolder(path);
    return this.folderToRemoteEntry(normalizeFolderPathLower(path), path.replace(/\/+$/, ""));
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- sync-only implementation
  async listRevisions(path: string): Promise<RemoteRevision[]> {
    const pathLower = path.toLowerCase();
    return [...(this.revisionHistory.get(pathLower) ?? [])];
  }

  /**
   * Clear revision history for a path (or all paths) so list_revisions looks
   * aged-out — row 83 ask path instead of R10 (G3).
   */
  expireRevisions(path?: string): void {
    if (path === undefined) {
      this.revisionHistory.clear();
      return;
    }
    this.revisionHistory.delete(path.toLowerCase());
  }

  /** Simulate Dropbox invalidating a delta cursor — stale cursors throw on next listChanges. */
  invalidateCursor(): void {
    this.cursorInvalidated = true;
  }

  /** Test helper: register an empty folder (path_lower, trailing slash). */
  seedEmptyFolder(path: string): void {
    const normalized = normalizeFolderPathLower(path);
    const display = path.replace(/\/+$/, "");
    this.folders.set(normalized, display);
    this.addChangeLog(this.folderToRemoteEntry(normalized, display));
  }

  /** @deprecated Test helper — prefer {@link seedEmptyFolder}. */
  seedFolder(path: string): void {
    this.seedEmptyFolder(path);
  }

  /** Test helper: remove a tracked empty folder. */
  deleteFolder(path: string): void {
    const normalized = normalizeFolderPathLower(path);
    const display = this.folders.get(normalized) ?? path.replace(/\/+$/, "");
    this.folders.delete(normalized);
    this.addChangeLog({
      pathLower: display.toLowerCase(),
      pathDisplay: display,
      hash: null,
      serverModified: 0,
      rev: "",
      size: 0,
      deleted: true,
      isFolder: true,
    });
  }

  /** Test helper: list tracked folder path_lower keys. */
  listFolders(): string[] {
    return [...this.folders.keys()].sort();
  }

  hasFolder(path: string): boolean {
    return this.folders.has(normalizeFolderPathLower(path));
  }

  // 테스트 헬퍼
  has(path: string): boolean {
    const file = this.files.get(path.toLowerCase());
    return !!file && !file.deleted;
  }

  getFile(pathLower: string): RemoteFile | undefined {
    return this.files.get(pathLower);
  }

  getFileCount(): number {
    let count = 0;
    for (const f of this.files.values()) {
      if (!f.deleted) count++;
    }
    return count;
  }

  private nextRev(): string {
    return `rev_${++this.revCounter}`;
  }

  private addChangeLog(entry: RemoteEntry): void {
    this.changeLog.push({ entry, seq: ++this.seq });
  }

  private appendRevision(pathLower: string, file: RemoteFile): void {
    const record: RemoteRevision = {
      rev: file.rev,
      serverModified: file.serverModified,
      deleted: file.deleted,
      hash: file.deleted ? null : file.hash,
    };
    const history = this.revisionHistory.get(pathLower) ?? [];
    history.push(record);
    this.revisionHistory.set(pathLower, history);
  }

  private toRemoteEntry(file: RemoteFile): RemoteEntry {
    return {
      pathLower: file.pathLower,
      pathDisplay: file.pathDisplay,
      hash: file.hash,
      serverModified: file.serverModified,
      clientModified: file.clientModified,
      rev: file.rev,
      size: file.data.length,
      deleted: file.deleted,
      isFolder: false,
    };
  }

  private folderToRemoteEntry(folderKey: string, pathDisplay?: string): RemoteEntry {
    const display =
      pathDisplay
      ?? this.folders.get(folderKey)
      ?? folderKey.replace(/\/+$/, "");
    return {
      pathLower: folderKey.replace(/\/+$/, "").toLowerCase(),
      pathDisplay: display,
      hash: null,
      serverModified: Date.now(),
      rev: "",
      size: 0,
      deleted: false,
      isFolder: true,
    };
  }

  /** Include folder tags in delta listings (G8). */
  private buildFolderChangeEntries(fromSeq: number): RemoteEntry[] {
    if (fromSeq > 0) return [];
    return [...this.folders.entries()].map(([folderKey, display]) =>
      this.folderToRemoteEntry(folderKey, display),
    );
  }
}

function normalizeFolderPathLower(path: string): string {
  const trimmed = path.replace(/\/+$/, "").toLowerCase();
  return `${trimmed}/`;
}

// ── MemoryStateStore ──

export class MemoryStateStore implements SyncStateStore {
  private entries = new Map<string, SyncEntry>();
  private meta = new Map<string, string>();

  getEntry(pathLower: string): Promise<SyncEntry | null> {
    return Promise.resolve(this.entries.get(pathLower) ?? null);
  }

  setEntry(entry: SyncEntry): Promise<void> {
    this.entries.set(entry.pathLower, { ...entry });
    return Promise.resolve();
  }

  deleteEntry(pathLower: string): Promise<void> {
    this.entries.delete(pathLower);
    return Promise.resolve();
  }

  getAllEntries(): Promise<SyncEntry[]> {
    return Promise.resolve([...this.entries.values()]);
  }

  clear(): Promise<void> {
    this.entries.clear();
    this.meta.clear();
    return Promise.resolve();
  }

  getMeta(key: string): Promise<string | null> {
    return Promise.resolve(this.meta.get(key) ?? null);
  }

  setMeta(key: string, value: string): Promise<void> {
    this.meta.set(key, value);
    return Promise.resolve();
  }

  // 테스트 헬퍼
  getEntryCount(): number {
    return this.entries.size;
  }
}
