import { normalizePath, type Vault, TFile, TAbstractFile, FileManager } from "obsidian";
import type { FileListOptions, FileSystem } from "./interfaces";
import type { FileInfo } from "../types";
import { dropboxContentHashBrowser } from "../hash.browser";
import { isExcluded } from "../exclude";
import { listFilesRecursive } from "./vault-disk-list";

interface HashCacheEntry {
  mtime: number;
  size: number;
  hash: string;
}

export interface VaultListStats {
  vaultIndexed: number;
  configDiskAdded: number;
  hiddenDiskAdded: number;
  mergedBeforeExclude: number;
  mergedAfterExclude: number;
}

/**
 * Obsidian Vault API wrapper implementing FileSystem.
 *
 * Discovery: vault.getFiles() plus optional vault.adapter disk scans for
 * config and hidden paths (Vault API is incomplete inside dot-folders).
 * Mutations: Vault API for indexed notes; DataAdapter for config/dot paths
 * because createBinary/getAbstractFileByPath are unreliable there
 * (obsidian-developer-docs#186) — without this, plugin downloads appear to
 * sync but never land on disk in a way Obsidian can load.
 */
export type LocalFileScanCallback = (path: string, detail: "cached" | "hashed" | "disk") => void;

export class VaultAdapter implements FileSystem {
  private hashCache = new Map<string, HashCacheEntry>();
  private diskOnlyPaths = new Set<string>();
  private abortSignal: AbortSignal | null = null;
  private configDirLower: string;
  onLocalFileScanned: LocalFileScanCallback | null = null;
  lastListStats: VaultListStats = {
    vaultIndexed: 0,
    configDiskAdded: 0,
    hiddenDiskAdded: 0,
    mergedBeforeExclude: 0,
    mergedAfterExclude: 0,
  };

  constructor(
    private vault: Vault,
    private excludePatterns: string[] = [],
    private fileManager: FileManager,
    configDir = ".obsidian",
  ) {
    this.configDirLower = configDir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }

  setAbortSignal(signal: AbortSignal | null): void {
    this.abortSignal = signal;
  }

  async read(path: string): Promise<Uint8Array> {
    const file = this.vault.getAbstractFileByPath(path);
    if (file && this.isTFile(file)) {
      const buffer = await this.vault.readBinary(file);
      return new Uint8Array(buffer);
    }
    if (this.isAdapterBackedPath(path)) {
      const buffer = await this.vault.adapter.readBinary(normalizePath(path));
      return new Uint8Array(buffer);
    }
    return this.readViaIndexedFile(path);
  }

  async write(path: string, data: Uint8Array, mtime?: number): Promise<void> {
    const options = mtime ? { mtime } : undefined;
    const arrayBuffer = toArrayBuffer(data);

    // Config/dot paths must use DataAdapter — Vault createBinary is partial there.
    if (this.isAdapterBackedPath(path)) {
      await this.ensureParentDirViaAdapter(path);
      await this.vault.adapter.writeBinary(normalizePath(path), arrayBuffer, options);
      this.diskOnlyPaths.add(path.toLowerCase());
      this.hashCache.delete(path.toLowerCase());
      return;
    }

    const existing = this.vault.getAbstractFileByPath(path);
    if (existing && this.isTFile(existing)) {
      await this.vault.modifyBinary(existing, arrayBuffer, options);
    } else {
      await this.ensureParentDir(path);
      await this.vault.createBinary(path, arrayBuffer, options);
      this.diskOnlyPaths.delete(path.toLowerCase());
    }
  }

  async delete(path: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(path);
    if (file) {
      await this.fileManager.trashFile(file);
    } else if (this.isAdapterBackedPath(path)) {
      // Disk-only config/plugin files are invisible to Vault trash APIs.
      const norm = normalizePath(path);
      if (await this.vault.adapter.exists(norm)) {
        await this.vault.adapter.remove(norm);
      }
    }
    this.diskOnlyPaths.delete(path.toLowerCase());
    this.hashCache.delete(path.toLowerCase());
  }

  async rename(from: string, to: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(from);
    if (file && this.isTFile(file)) {
      await this.ensureParentDir(to);
      await this.fileManager.renameFile(file, to);
    } else if (this.isAdapterBackedPath(from)) {
      await this.ensureParentDirViaAdapter(to);
      await this.vault.adapter.rename(normalizePath(from), normalizePath(to));
    } else {
      throw new Error(`File not found: ${from}`);
    }
    const fromLower = from.toLowerCase();
    const toLower = to.toLowerCase();
    if (this.diskOnlyPaths.has(fromLower) || this.isAdapterBackedPath(to)) {
      this.diskOnlyPaths.delete(fromLower);
      this.diskOnlyPaths.add(toLower);
    }
    this.hashCache.delete(fromLower);
    this.hashCache.delete(toLower);
  }

  async list(options?: FileListOptions): Promise<FileInfo[]> {
    this.diskOnlyPaths.clear();
    const byPath = new Map<string, FileInfo>();
    const nextCache = new Map<string, HashCacheEntry>();

    // Pass 1 — indexed (vault.getFiles)
    for (const file of this.vault.getFiles()) {
      this.abortSignal?.throwIfAborted();
      const info = await this.fileInfoFromIndexed(file, nextCache);
      if (info) {
        byPath.set(info.pathLower, info);
      }
    }
    const vaultIndexed = byPath.size;

    const adapter = this.vault.adapter;
    const skipDirPrefixes = this.excludePatterns
      .filter((p) => p.endsWith("/"))
      .map((p) => p.replace(/\/+$/, ""));

    // Config scan is independent of includeHiddenFilesAndFolders: section
    // toggles (settings/plugins/workspaces) always need .obsidian on disk.
    let configDiskAdded = 0;
    if (options?.configDiskScan && options.configDir) {
      const diskFiles = await listFilesRecursive(adapter, options.configDir, {
        signal: this.abortSignal,
        skipDirPrefixes,
      });
      configDiskAdded = await this.mergeDiskFiles(diskFiles, byPath, nextCache);
    }

    let hiddenDiskAdded = 0;
    if (options?.includeHiddenFilesAndFolders) {
      const diskFiles = await listFilesRecursive(adapter, "", {
        signal: this.abortSignal,
        skipDirPrefixes,
      });
      const before = byPath.size;
      await this.mergeDiskFiles(diskFiles, byPath, nextCache);
      hiddenDiskAdded = byPath.size - before;
    }

    const mergedBeforeExclude = byPath.size;
    const merged = [...byPath.values()].filter((f) => !this.shouldExclude(f.path));
    const mergedAfterExclude = merged.length;

    this.hashCache = nextCache;
    this.lastListStats = {
      vaultIndexed,
      configDiskAdded,
      hiddenDiskAdded,
      mergedBeforeExclude,
      mergedAfterExclude,
    };

    return merged;
  }

  async stat(path: string): Promise<{ mtime: number; size: number }> {
    const file = this.vault.getAbstractFileByPath(path);
    if (file && this.isTFile(file)) {
      return { mtime: file.stat.mtime, size: file.stat.size };
    }
    if (this.isAdapterBackedPath(path)) {
      const st = await this.vault.adapter.stat(normalizePath(path));
      if (st) return { mtime: st.mtime, size: st.size };
    }
    return this.statViaIndexedFile(path);
  }

  async computeHash(path: string): Promise<string> {
    const file = this.vault.getAbstractFileByPath(path);
    if (file && this.isTFile(file)) {
      const data = await this.vault.readBinary(file);
      return dropboxContentHashBrowser(new Uint8Array(data));
    }
    if (this.isAdapterBackedPath(path)) {
      const data = await this.vault.adapter.readBinary(normalizePath(path));
      return dropboxContentHashBrowser(new Uint8Array(data));
    }
    return this.computeHashViaIndexedFile(path);
  }

  clearCache(): void {
    this.hashCache.clear();
  }

  // ── private ──

  /**
   * Paths Obsidian does not reliably index or mutate via Vault APIs.
   * Includes configDir (.obsidian), any dot-segment path, and known disk-only entries.
   */
  private isAdapterBackedPath(path: string): boolean {
    const lower = path.replace(/\\/g, "/").toLowerCase();
    if (this.diskOnlyPaths.has(lower)) return true;
    if (lower === this.configDirLower || lower.startsWith(`${this.configDirLower}/`)) return true;
    return path.split("/").some((segment) => segment.startsWith("."));
  }

  private async readViaIndexedFile(path: string): Promise<Uint8Array> {
    const file = this.getFile(path);
    const buffer = await this.vault.readBinary(file);
    return new Uint8Array(buffer);
  }

  private async statViaIndexedFile(path: string): Promise<{ mtime: number; size: number }> {
    const file = this.getFile(path);
    return { mtime: file.stat.mtime, size: file.stat.size };
  }

  private async computeHashViaIndexedFile(path: string): Promise<string> {
    const file = this.getFile(path);
    const data = await this.vault.readBinary(file);
    return dropboxContentHashBrowser(new Uint8Array(data));
  }

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

  private async fileInfoFromIndexed(
    file: TFile,
    nextCache: Map<string, HashCacheEntry>,
  ): Promise<FileInfo | null> {
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
    return {
      path: file.path,
      pathLower,
      hash,
      mtime: file.stat.mtime,
      size: file.stat.size,
    };
  }

  private async mergeDiskFiles(
    diskFiles: { path: string; mtime: number; size: number }[],
    byPath: Map<string, FileInfo>,
    nextCache: Map<string, HashCacheEntry>,
  ): Promise<number> {
    let added = 0;
    for (const disk of diskFiles) {
      this.abortSignal?.throwIfAborted();
      const pathLower = disk.path.toLowerCase();
      if (byPath.has(pathLower)) continue;

      const cached = this.hashCache.get(pathLower);
      let hash: string;
      if (cached && cached.mtime === disk.mtime && cached.size === disk.size) {
        hash = cached.hash;
        this.onLocalFileScanned?.(disk.path, "cached");
      } else {
        const data = await this.vault.adapter.readBinary(normalizePath(disk.path));
        hash = await dropboxContentHashBrowser(new Uint8Array(data));
        this.onLocalFileScanned?.(disk.path, "disk");
      }

      nextCache.set(pathLower, { mtime: disk.mtime, size: disk.size, hash });
      this.diskOnlyPaths.add(pathLower);
      byPath.set(pathLower, {
        path: disk.path,
        pathLower,
        hash,
        mtime: disk.mtime,
        size: disk.size,
      });
      added++;
    }
    return added;
  }

  /** Create parent folders for indexed (non-dot) paths via Vault API. */
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
          if (this.vault.getAbstractFileByPath(current)) continue;
          if (isFolderAlreadyExistsError(e)) continue;
          throw e;
        }
      }
    }
  }

  /** Create parent folders for config/dot paths via DataAdapter.mkdir. */
  private async ensureParentDirViaAdapter(path: string): Promise<void> {
    const parts = path.split("/");
    if (parts.length <= 1) return;

    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current = current ? `${current}/${parts[i]}` : parts[i];
      const norm = normalizePath(current);
      try {
        if (!(await this.vault.adapter.exists(norm))) {
          await this.vault.adapter.mkdir(norm);
        }
      } catch (e) {
        if (isFolderAlreadyExistsError(e)) continue;
        // Parallel downloads may race on mkdir; treat exists-after-error as ok.
        if (await this.vault.adapter.exists(norm)) continue;
        throw e;
      }
    }
  }
}

/** Obsidian throws this when createFolder races or the folder exists on disk but is not indexed yet. */
export function isFolderAlreadyExistsError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /folder already exists/i.test(msg);
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}
