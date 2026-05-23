import type { Vault, TFile, TAbstractFile, FileManager } from "obsidian";
import type { FileSystem } from "./interfaces";
import type { FileInfo } from "../types";
import { dropboxContentHashBrowser } from "../hash.browser";
import { isExcluded } from "../exclude";

interface HashCacheEntry {
  mtime: number;
  size: number;
  hash: string;
}

/**
 * Obsidian Vault API를 FileSystem 인터페이스로 래핑.
 *
 * 항상 Vault API를 사용한다 (adapter 직접 사용 X).
 * → 이벤트가 올바르게 발화되고, MetadataCache가 자동 업데이트됨.
 *
 * list()는 mtime/size 기반 해시 캐시를 사용해서
 * 변경되지 않은 파일의 재해싱을 건너뛴다.
 */
export type LocalFileScanCallback = (path: string, detail: "cached" | "hashed") => void;

export class VaultAdapter implements FileSystem {
  private hashCache = new Map<string, HashCacheEntry>();
  private abortSignal: AbortSignal | null = null;
  onLocalFileScanned: LocalFileScanCallback | null = null;

  constructor(private vault: Vault, private excludePatterns: string[] = [], private fileManager: FileManager) {}

  setAbortSignal(signal: AbortSignal | null): void {
    this.abortSignal = signal;
  }

  async read(path: string): Promise<Uint8Array> {
    const file = this.getFile(path);
    const buffer = await this.vault.readBinary(file);
    return new Uint8Array(buffer);
  }

  async write(path: string, data: Uint8Array, mtime?: number): Promise<void> {
    const existing = this.vault.getAbstractFileByPath(path);
    const options = mtime ? { mtime } : undefined;

    if (existing && this.isTFile(existing)) {
      await this.vault.modifyBinary(existing, data.buffer as ArrayBuffer, options);
    } else {
      await this.ensureParentDir(path);
      await this.vault.createBinary(path, data.buffer as ArrayBuffer, options);
    }
  }

  async delete(path: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(path);
    if (file) {
      await this.fileManager.trashFile(file);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(from);
    if (!file || !this.isTFile(file)) {
      throw new Error(`File not found: ${from}`);
    }
    await this.ensureParentDir(to);
    await this.fileManager.renameFile(file, to);
    this.hashCache.delete(from.toLowerCase());
    this.hashCache.delete(to.toLowerCase());
  }

  async list(): Promise<FileInfo[]> {
    const files = this.vault.getFiles();
    const result: FileInfo[] = [];
    const nextCache = new Map<string, HashCacheEntry>();

    for (const file of files) {
      this.abortSignal?.throwIfAborted();
      if (this.shouldExclude(file.path)) continue;

      const pathLower = file.path.toLowerCase();
      const cached = this.hashCache.get(pathLower);

      let hash: string;
      if (cached && cached.mtime === file.stat.mtime && cached.size === file.stat.size) {
        hash = cached.hash;
        this.onLocalFileScanned?.(file.path, "cached");
      } else {
        const data = await this.vault.readBinary(file);
        hash = await dropboxContentHashBrowser(new Uint8Array(data));
        this.onLocalFileScanned?.(file.path, "hashed");
      }

      nextCache.set(pathLower, { mtime: file.stat.mtime, size: file.stat.size, hash });
      result.push({
        path: file.path,
        pathLower,
        hash,
        mtime: file.stat.mtime,
        size: file.stat.size,
      });
    }

    this.hashCache = nextCache;
    return result;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async wraps sync throw into rejection
  async stat(path: string): Promise<{ mtime: number; size: number }> {
    const file = this.getFile(path);
    return { mtime: file.stat.mtime, size: file.stat.size };
  }

  async computeHash(path: string): Promise<string> {
    const file = this.getFile(path);
    const data = await this.vault.readBinary(file);
    return dropboxContentHashBrowser(new Uint8Array(data));
  }

  clearCache(): void {
    this.hashCache.clear();
  }

  // ── private ──

  private getFile(path: string): TFile {
    const file = this.vault.getAbstractFileByPath(path);
    if (!file || !this.isTFile(file)) {
      throw new Error(`File not found: ${path}`);
    }
    return file;
  }

  private isTFile(file: TAbstractFile): file is TFile {
    return "stat" in file && "extension" in file;
  }

  private shouldExclude(path: string): boolean {
    return isExcluded(path, this.excludePatterns);
  }

  private async ensureParentDir(path: string): Promise<void> {
    const parts = path.split("/");
    if (parts.length <= 1) return;

    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current = current ? `${current}/${parts[i]}` : parts[i];
      const existing = this.vault.getAbstractFileByPath(current);
      if (!existing) {
        try {
          await this.vault.createFolder(current);
        } catch (e) {
          // Parallel downloads may create the same folder first. On mobile the
          // vault index can lag behind createFolder, so also accept Obsidian's
          // "Folder already exists" error when the folder is on disk.
          if (this.vault.getAbstractFileByPath(current)) continue;
          if (isFolderAlreadyExistsError(e)) continue;
          throw e;
        }
      }
    }
  }
}

/** Obsidian throws this when createFolder races or the folder exists on disk but is not indexed yet. */
export function isFolderAlreadyExistsError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /folder already exists/i.test(msg);
}
