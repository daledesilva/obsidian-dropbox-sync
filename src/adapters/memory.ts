import { dropboxContentHash } from "../hash";
import {
  RevConflictError,
  type FileInfo,
  type RemoteEntry,
  type SyncEntry,
  type ListChangesResult,
  type DownloadResult,
} from "../types";
import type { FileListOptions, FileSystem, RemoteStorage, SyncStateStore } from "./interfaces";

// re-export for backward compat
export { RevConflictError };

// ── MemoryFileSystem ──

interface MemoryFile {
  data: Uint8Array;
  mtime: number;
}

export class MemoryFileSystem implements FileSystem {
  private files = new Map<string, MemoryFile>();

  // eslint-disable-next-line @typescript-eslint/require-await -- async wraps sync throw into rejection
  async read(path: string): Promise<Uint8Array> {
    const file = this.files.get(path);
    if (!file) throw new Error(`File not found: ${path}`);
    return file.data;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- sync-only implementation
  async write(path: string, data: Uint8Array, mtime?: number): Promise<void> {
    this.files.set(path, { data, mtime: mtime ?? Date.now() });
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
  deleted: boolean;
}

/** 변경 이력 엔트리 (cursor 시뮬레이션용) */
interface ChangeLogEntry {
  entry: RemoteEntry;
  seq: number;
}

export class MemoryRemoteStorage implements RemoteStorage {
  private files = new Map<string, RemoteFile>();
  private changeLog: ChangeLogEntry[] = [];
  private seq = 0;
  private revCounter = 0;

  // eslint-disable-next-line @typescript-eslint/require-await -- sync-only implementation
  async listChanges(cursor?: string): Promise<ListChangesResult> {
    const fromSeq = cursor ? parseInt(cursor, 10) : 0;
    const entries = this.changeLog
      .filter((c) => c.seq > fromSeq)
      .map((c) => c.entry);

    return {
      entries,
      cursor: String(this.seq),
      hasMore: false,
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

    const newRev = this.nextRev();
    const hash = await dropboxContentHash(data);
    const now = Date.now();

    const file: RemoteFile = {
      pathLower,
      pathDisplay: path,
      data: new Uint8Array(data),
      hash,
      rev: newRev,
      serverModified: now,
      deleted: false,
    };

    this.files.set(pathLower, file);
    this.addChangeLog(this.toRemoteEntry(file));

    return this.toRemoteEntry(file);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- sync-only implementation
  async delete(path: string): Promise<void> {
    const pathLower = path.toLowerCase();
    const file = this.files.get(pathLower);
    if (!file) return;

    file.deleted = true;
    this.addChangeLog({
      ...this.toRemoteEntry(file),
      deleted: true,
      hash: null,
    });
  }

  async move(from: string, to: string): Promise<RemoteEntry> {
    const fromLower = from.toLowerCase();
    const file = this.files.get(fromLower);
    if (!file || file.deleted) {
      throw new Error(`File not found on remote: ${from}`);
    }
    this.files.delete(fromLower);
    const toLower = to.toLowerCase();
    file.pathLower = toLower;
    file.pathDisplay = to;
    this.files.set(toLower, file);
    const entry = this.toRemoteEntry(file);
    this.addChangeLog(entry);
    return entry;
  }

  // 테스트 헬퍼
  has(pathLower: string): boolean {
    const file = this.files.get(pathLower);
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

  private toRemoteEntry(file: RemoteFile): RemoteEntry {
    return {
      pathLower: file.pathLower,
      pathDisplay: file.pathDisplay,
      hash: file.hash,
      serverModified: file.serverModified,
      rev: file.rev,
      size: file.data.length,
      deleted: file.deleted,
    };
  }
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
