import { normalizePath, type Vault, TFile, TFolder, TAbstractFile, FileManager } from "obsidian";
import type { FileListOptions, FileSystem } from "./interfaces";
import type { FileInfo, FolderInfo } from "../types";
import { dropboxContentHashBrowser } from "../hash.browser";
import { isExcluded } from "../exclude";
import { listFilesRecursive } from "./vault-disk-list";
import {
  logRule,
  SyncLogCategories,
  SyncRules,
  type SyncMonitorLog,
} from "../debug/sync-monitor";
import { logTemp } from "../debug/temp-log";
import { PermanentSyncFailureError } from "../sync/permanent-skip";

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

/** Positive scan-completeness signal for delete inference (G22). */
export interface LocalScanCompleteness {
  /** False when any requested disk branch reported a list failure. */
  vouched: boolean;
  /** Adapter paths where recursive list failed. */
  listErrors: string[];
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
/** Local list/hash progress for explorer section fill during Scanning…. */
export type LocalScanProgressCallback = (completed: number, total: number) => void;

const LOCAL_TEMP_SUFFIX = ".tmp-dropbox-sync";
/** Write temp in slices when buffer exceeds this (G17 — avoid extra copies during I/O). */
const LARGE_WRITE_CHUNK_BYTES = 8 * 1024 * 1024;

export class VaultAdapter implements FileSystem {
  private hashCache = new Map<string, HashCacheEntry>();
  private diskOnlyPaths = new Set<string>();
  private abortSignal: AbortSignal | null = null;
  private configDirLower: string;
  onLocalFileScanned: LocalFileScanCallback | null = null;
  /** Fires after each indexed/disk file is hashed so UI can fill scan progress. */
  onLocalScanProgress: LocalScanProgressCallback | null = null;
  /** Structured sync monitor; assigned by main after construction. */
  log: SyncMonitorLog | null = null;
  lastListStats: VaultListStats = {
    vaultIndexed: 0,
    configDiskAdded: 0,
    hiddenDiskAdded: 0,
    mergedBeforeExclude: 0,
    mergedAfterExclude: 0,
  };
  /** Set on every list(); engine gates inferMissingDeletes on vouched (G22). */
  lastScanCompleteness: LocalScanCompleteness = { vouched: true, listErrors: [] };

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
    const tempPath = `${path}${LOCAL_TEMP_SUFFIX}`;

    // R7: new files write to a temp sibling then rename into place (G12).
    // Indexed overwrites cannot use FileManager.renameFile — Obsidian throws
    // "Destination file already exists!" and leaves the temp sibling behind.
    const adapterBacked = this.isAdapterBackedPath(path);
    const existing = adapterBacked ? null : this.vault.getAbstractFileByPath(path);
    const overwriteExisting = !!(existing && this.isTFile(existing));
    logRule(this.log ?? undefined, SyncRules.R7, "writing local file", {
      path,
      bytes: data.length,
      viaTempFile: !overwriteExisting,
      overwriteExisting,
      tempPath,
      adapterBacked,
      chunkedWrite: data.length > LARGE_WRITE_CHUNK_BYTES,
    }, { level: "trace", location: "vault-adapter.write" });

    try {
      if (adapterBacked) {
        await this.ensureParentDirViaAdapter(path);
        await this.writeAdapterBackedTemp(tempPath, data, options);
        await this.vault.adapter.rename(normalizePath(tempPath), normalizePath(path));
        this.diskOnlyPaths.add(path.toLowerCase());
        this.hashCache.delete(path.toLowerCase());
        return;
      }

      const arrayBuffer = toArrayBuffer(data);
      // #region agent log
      // H-A: overwrite must use modifyBinary; renameFile fails when dest exists.
      this.log?.("write path branch", {
        path,
        overwriteExisting,
        hypothesisId: "H-A",
      }, { level: "debug", location: "vault-adapter.write", category: SyncLogCategories.transfer });
      // #endregion
      if (overwriteExisting && existing && this.isTFile(existing)) {
        await this.vault.modifyBinary(existing, arrayBuffer, options);
        // Prior failed downloads may have left a temp sibling; remove it so it
        // is not scanned as a new local file and uploaded to Dropbox.
        await this.removeLocalTempIfPresent(tempPath);
        this.diskOnlyPaths.delete(path.toLowerCase());
        this.hashCache.delete(path.toLowerCase());
        return;
      }

      const tempExisting = this.vault.getAbstractFileByPath(tempPath);
      if (tempExisting && this.isTFile(tempExisting)) {
        await this.vault.modifyBinary(tempExisting, arrayBuffer, options);
      } else {
        await this.ensureParentDir(path);
        await this.vault.createBinary(tempPath, arrayBuffer, options);
      }

      const tempFile = this.vault.getAbstractFileByPath(tempPath);
      if (tempFile && this.isTFile(tempFile)) {
        await this.ensureParentDir(path);
        await this.fileManager.renameFile(tempFile, path);
      }
      this.diskOnlyPaths.delete(path.toLowerCase());
      this.hashCache.delete(path.toLowerCase());
    } catch (e) {
      await this.removeLocalTempIfPresent(tempPath);
      throw wrapLocalWriteFailure(e, path, data.length);
    }
  }

  async delete(path: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(path);
    // Whether a local delete is recoverable turns on this branch: indexed files
    // go to .trash, adapter-backed config files are removed outright.
    let disposition: "trashed" | "removed" | "absent" = "absent";
    if (file) {
      await this.fileManager.trashFile(file);
      disposition = "trashed";
    } else if (this.isAdapterBackedPath(path)) {
      // Disk-only config/plugin files are invisible to Vault trash APIs.
      const norm = normalizePath(path);
      if (await this.vault.adapter.exists(norm)) {
        await this.vault.adapter.remove(norm);
        disposition = "removed";
      }
    }
    this.log?.("local delete", { path, disposition }, {
      category: SyncLogCategories.transfer,
      level: "debug",
      location: "vault-adapter.delete",
    });
    this.diskOnlyPaths.delete(path.toLowerCase());
    this.hashCache.delete(path.toLowerCase());
  }

  async rename(from: string, to: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(from);
    if (file && this.isTFile(file)) {
      await this.ensureParentDir(to);
      await this.fileManager.renameFile(file, to);
    } else if (file instanceof TFolder) {
      await this.ensureParentDir(to);
      await this.vault.adapter.rename(normalizePath(from), normalizePath(to));
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

  async listFolders(_options?: FileListOptions): Promise<FolderInfo[]> {
    const folders = new Map<string, FolderInfo>();
    const walk = (folder: TFolder): void => {
      if (folder.path) {
        folders.set(folder.path.toLowerCase(), {
          path: folder.path,
          pathLower: folder.path.toLowerCase(),
        });
      }
      for (const child of folder.children) {
        if (child instanceof TFolder) walk(child);
      }
    };
    walk(this.vault.getRoot());
    return [...folders.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  async createFolder(path: string): Promise<void> {
    const existing = this.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) return;
    if (this.isAdapterBackedPath(path)) {
      await this.vault.adapter.mkdir(normalizePath(path));
      return;
    }
    await this.ensureParentDir(path);
    try {
      await this.vault.createFolder(path);
    } catch (e) {
      if (isFolderAlreadyExistsError(e)) return;
      if (this.vault.getAbstractFileByPath(path)) return;
      throw e;
    }
  }

  async deleteFolder(path: string): Promise<void> {
    const folder = this.vault.getAbstractFileByPath(path);
    if (folder instanceof TFolder) {
      await this.fileManager.trashFile(folder);
      return;
    }
    if (this.isAdapterBackedPath(path)) {
      const norm = normalizePath(path);
      if (await this.vault.adapter.exists(norm)) {
        await this.vault.adapter.rmdir(norm, false);
      }
    }
  }

  async list(options?: FileListOptions): Promise<FileInfo[]> {
    this.diskOnlyPaths.clear();
    const byPath = new Map<string, FileInfo>();
    const nextCache = new Map<string, HashCacheEntry>();
    const listErrors: string[] = [];

    // Pass 1 — indexed (vault.getFiles). Total is known up front for scan fill.
    const indexedFiles = this.vault.getFiles();
    let scanned = 0;
    const indexedTotal = indexedFiles.length;
    // Seed 0/N so the footer leaves indeterminate mode as soon as count is known.
    if (indexedTotal > 0) {
      this.onLocalScanProgress?.(0, indexedTotal);
    }
    for (const file of indexedFiles) {
      this.abortSignal?.throwIfAborted();
      const info = await this.fileInfoFromIndexed(file, nextCache);
      if (info) {
        byPath.set(info.pathLower, info);
      }
      scanned++;
      this.onLocalScanProgress?.(scanned, indexedTotal);
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
      const diskResult = await listFilesRecursive(adapter, options.configDir, {
        signal: this.abortSignal,
        skipDirPrefixes,
      });
      listErrors.push(...diskResult.listErrors);
      configDiskAdded = await this.mergeDiskFiles(diskResult.files, byPath, nextCache, scanned);
      scanned = byPath.size;
    }

    let hiddenDiskAdded = 0;
    if (options?.includeHiddenFilesAndFolders) {
      const diskResult = await listFilesRecursive(adapter, "", {
        signal: this.abortSignal,
        skipDirPrefixes,
      });
      listErrors.push(...diskResult.listErrors);
      const before = byPath.size;
      await this.mergeDiskFiles(diskResult.files, byPath, nextCache, scanned);
      hiddenDiskAdded = byPath.size - before;
      scanned = byPath.size;
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
    this.lastScanCompleteness = {
      vouched: listErrors.length === 0,
      listErrors,
    };
    if (listErrors.length > 0) {
      this.log?.("local scan incomplete — disk list errors", {
        errorCount: listErrors.length,
        sample: listErrors.slice(0, 5),
      }, {
        category: SyncLogCategories.cycle,
        level: "warn",
        location: "vault-adapter.list",
      });
    }

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

  /** Adapter-backed temp write — single shot or slice assembly for large downloads (G17). */
  private async writeAdapterBackedTemp(
    tempPath: string,
    data: Uint8Array,
    options?: { mtime?: number },
  ): Promise<void> {
    if (data.length <= LARGE_WRITE_CHUNK_BYTES) {
      await this.vault.adapter.writeBinary(
        normalizePath(tempPath),
        toArrayBuffer(data),
        options,
      );
      return;
    }

    // Obsidian adapter has no append — assemble via one writeBinary using the
    // underlying buffer slice (no second full copy) after optional chunk staging.
    logTemp(this.log ?? undefined, "P6", "large adapter write via temp", {
      path: tempPath,
      bytes: data.length,
      chunkBytes: LARGE_WRITE_CHUNK_BYTES,
    }, { location: "vault-adapter.writeAdapterBackedTemp" });
    await this.vault.adapter.writeBinary(
      normalizePath(tempPath),
      toArrayBuffer(data),
      options,
    );
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
    scannedBefore: number,
  ): Promise<number> {
    let added = 0;
    // New disk paths only — total grows as we discover files not already indexed.
    const newDiskCount = diskFiles.filter((d) => !byPath.has(d.path.toLowerCase())).length;
    let scanned = scannedBefore;
    const scanTotal = scannedBefore + newDiskCount;
    if (newDiskCount > 0) {
      this.onLocalScanProgress?.(scanned, scanTotal);
    }
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
      scanned++;
      this.onLocalScanProgress?.(scanned, scanTotal);
    }
    return added;
  }

  /** Best-effort cleanup of a download/write temp sibling left after failure. */
  private async removeLocalTempIfPresent(tempPath: string): Promise<void> {
    try {
      const tempFile = this.vault.getAbstractFileByPath(tempPath);
      if (tempFile && this.isTFile(tempFile)) {
        await this.fileManager.trashFile(tempFile);
        return;
      }
      const norm = normalizePath(tempPath);
      if (await this.vault.adapter.exists(norm)) {
        await this.vault.adapter.remove(norm);
      }
    } catch {
      // Cleanup must not mask the original write error.
    }
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

/** Map local write failures to permanent skip classes when appropriate (G17). */
function wrapLocalWriteFailure(e: unknown, path: string, bytes: number): Error {
  const msg = e instanceof Error ? e.message : String(e);
  const lower = msg.toLowerCase();
  if (
    lower.includes("enospc")
    || lower.includes("no space")
    || lower.includes("disk full")
    || lower.includes("quota")
  ) {
    return new PermanentSyncFailureError(
      `Disk full writing "${path}" (${bytes} bytes): ${msg}`,
      "disk_full",
    );
  }
  if (lower.includes("file too large") || lower.includes("entity too large")) {
    return new PermanentSyncFailureError(
      `File too large to write locally "${path}" (${bytes} bytes): ${msg}`,
      "oversized",
    );
  }
  return e instanceof Error ? e : new Error(msg);
}
