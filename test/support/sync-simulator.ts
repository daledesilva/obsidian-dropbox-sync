import {
  MemoryFileSystem,
  MemoryRemoteStorage,
  MemoryStateStore,
} from "@/adapters/memory";
import type { RemoteStorage } from "@/adapters/interfaces";
import { SyncEngine, type CycleResult, type SyncEngineOptions } from "@/sync/engine";
import { findNewestConflictSibling, isConflictFile } from "@/sync/conflict-handlers";
import type { VaultSection } from "@/sync/sync-scope";
import { FailingRemoteStorage } from "./failing-remote";

/** Thrown when {@link Device.sync} is called while the device is offline. */
export class DeviceOfflineError extends Error {
  constructor(deviceName: string) {
    super(`Device offline: ${deviceName}`);
    this.name = "DeviceOfflineError";
  }
}

/**
 * Sentinel returned by {@link Device.sync} when offline (alternative to throw).
 * Prefer checking with {@link isOfflineCycleResult} when using the sentinel path.
 */
export type OfflineCycleResult = { offline: true };

export function isOfflineCycleResult(
  result: CycleResult | OfflineCycleResult,
): result is OfflineCycleResult {
  return "offline" in result && result.offline === true;
}

/**
 * Models a device using the Dropbox desktop client (P3): writes only to remote
 * storage with no SyncEngine or sync-state store.
 */
export class DropboxAppDevice {
  constructor(
    readonly name: string,
    private readonly remote: MemoryRemoteStorage,
  ) {}

  /**
   * Dropbox desktop client overwrite — not plugin `add`/`update(rev)`.
   * Uses MemoryRemoteStorage.forceUpload so P3 peer edits replace remote bytes.
   */
  async upload(path: string, content: string | Uint8Array): Promise<void> {
    const data =
      typeof content === "string" ? new TextEncoder().encode(content) : content;
    await this.remote.forceUpload(path, data);
  }

  async delete(path: string): Promise<void> {
    await this.remote.delete(path);
  }

  async move(from: string, to: string): Promise<void> {
    await this.remote.move(from, to);
  }

  async createFolder(path: string): Promise<void> {
    this.remote.seedEmptyFolder(path);
  }

  async deleteFolder(path: string): Promise<void> {
    this.remote.deleteFolder(path);
  }
}

/**
 * 다기기 동기화 시뮬레이터.
 *
 * 모든 device가 하나의 MemoryRemoteStorage를 공유한다.
 * 각 device는 독립된 MemoryFileSystem과 MemoryStateStore를 갖는다.
 */
export class SyncSimulator {
  readonly remote: MemoryRemoteStorage;
  private devices = new Map<string, Device>();

  constructor() {
    this.remote = new MemoryRemoteStorage();
  }

  addDevice(name: string, options?: SyncEngineOptions): Device {
    const device = new Device(name, this.remote, options);
    this.devices.set(name, device);
    return device;
  }

  /**
   * Device whose remote is wrapped in {@link FailingRemoteStorage} for rows 94–95 / 100.
   * Shares the same MemoryRemoteStorage as other devices.
   */
  addDeviceWithFailingRemote(
    name: string,
    options?: SyncEngineOptions,
  ): { device: Device; failingRemote: FailingRemoteStorage } {
    const failingRemote = new FailingRemoteStorage(this.remote);
    const device = new Device(name, failingRemote, options);
    this.devices.set(name, device);
    return { device, failingRemote };
  }

  /** Dropbox desktop client — remote-only writes, no plugin sync engine. */
  addDropboxAppDevice(name: string): DropboxAppDevice {
    return new DropboxAppDevice(name, this.remote);
  }

  getDevice(name: string): Device {
    const device = this.devices.get(name);
    if (!device) throw new Error(`Device not found: ${name}`);
    return device;
  }

  /**
   * 지정된 경로의 파일이 모든 device에서 동일한 내용인지 검증.
   * conflict 파일은 검증에서 제외.
   */
  async assertConsistent(path: string): Promise<void> {
    const hashes: { device: string; hash: string }[] = [];

    for (const [name, device] of this.devices) {
      if (!device.fs.has(path)) continue;
      const hash = await device.fs.computeHash(path);
      hashes.push({ device: name, hash });
    }

    if (hashes.length <= 1) return;

    const first = hashes[0].hash;
    for (const h of hashes.slice(1)) {
      if (h.hash !== first) {
        throw new Error(
          `Inconsistent content for "${path}": ${hashes.map((h) => `${h.device}=${h.hash.slice(0, 8)}`).join(", ")}`,
        );
      }
    }
  }

  /**
   * 모든 device의 모든 파일이 일치하는지 검증.
   * (conflict copies 제외 — canonical path만)
   */
  async assertAllConsistent(): Promise<void> {
    const allPaths = new Set<string>();
    for (const device of this.devices.values()) {
      const files = await device.fs.list();
      for (const f of files) {
        if (!isConflictFile(f.path)) {
          allPaths.add(f.path);
        }
      }
    }

    for (const path of allPaths) {
      await this.assertConsistent(path);
    }
  }
}

export class Device {
  readonly fs: MemoryFileSystem;
  readonly store: MemoryStateStore;
  readonly engine: SyncEngine;
  private isOffline = false;

  constructor(
    readonly name: string,
    remote: RemoteStorage,
    options?: SyncEngineOptions,
  ) {
    this.fs = new MemoryFileSystem();
    this.store = new MemoryStateStore();
    this.engine = new SyncEngine(
      { fs: this.fs, remote, store: this.store },
      {
        resurrectionResolver: async () => "upload",
        ...options,
      },
    );
  }

  async editFile(path: string, content: string, mtime?: number): Promise<void> {
    const data = new TextEncoder().encode(content);
    await this.fs.write(path, data, mtime);
  }

  async deleteFile(path: string): Promise<void> {
    await this.fs.delete(path);
    // 삭제 이벤트 자동 기록 (vault.on('delete') 시뮬레이션)
    this.engine.trackDelete(path.toLowerCase());
  }

  async rename(from: string, to: string): Promise<void> {
    await this.fs.rename(from, to);
    // Case-only renames keep path_lower — do not trackDelete (C1 / G6).
    if (from.toLowerCase() !== to.toLowerCase()) {
      this.engine.trackDelete(from.toLowerCase());
    }
  }

  /** Empty folder for G8 folder-first-class scenarios. */
  async createFolder(path: string): Promise<void> {
    await this.fs.createFolder(path);
  }

  async deleteFolder(path: string): Promise<void> {
    await this.fs.deleteFolder(path);
    this.engine.trackDelete(path.toLowerCase());
  }

  /**
   * Rename/move a folder and its children locally (G7/G8).
   * trackDelete only when path_lower changes (case-only folder rename is C1).
   */
  async renameFolder(from: string, to: string): Promise<void> {
    await this.fs.renameFolder(from, to);
    if (from.toLowerCase() !== to.toLowerCase()) {
      this.engine.trackDelete(from.toLowerCase());
    }
  }

  /** Force unvouched local scan so inferred deletes defer (G22 / row 31). */
  setScanUnvouched(listErrors: string[] = ["simulated-list-error"]): void {
    this.fs.setScanCompleteness({ vouched: false, listErrors });
  }

  setScanVouched(): void {
    this.fs.setScanCompleteness({ vouched: true, listErrors: [] });
  }

  goOffline(): void {
    this.isOffline = true;
  }

  goOnline(): void {
    this.isOffline = false;
  }

  get offline(): boolean {
    return this.isOffline;
  }

  setSections(sections: VaultSection[], configDir = ".obsidian"): void {
    this.engine.setSyncSections(sections, configDir);
  }

  /**
   * Run one sync cycle. Throws {@link DeviceOfflineError} when the device is offline.
   */
  async sync(): Promise<CycleResult> {
    if (this.isOffline) {
      throw new DeviceOfflineError(this.name);
    }
    return this.engine.runCycle();
  }

  /**
   * Like {@link sync} but returns `{ offline: true }` instead of throwing when offline.
   */
  async trySync(): Promise<CycleResult | OfflineCycleResult> {
    if (this.isOffline) {
      return { offline: true };
    }
    return this.engine.runCycle();
  }

  async readFile(path: string): Promise<string> {
    const data = await this.fs.read(path);
    return new TextDecoder().decode(data);
  }

  hasFile(path: string): boolean {
    return this.fs.has(path);
  }

  /** Newest conflict sibling for a canonical path (Dropbox or legacy format). */
  async findConflictSibling(canonicalPath: string): Promise<string | undefined> {
    const files = await this.fs.list();
    return findNewestConflictSibling(files.map((f) => f.path), canonicalPath) ?? undefined;
  }

  /** prefix로 시작하는 파일 경로 반환 */
  findFileByPrefix(prefix: string): string | undefined {
    return this.fs.findByPrefix(prefix);
  }

  async getFileHash(path: string): Promise<string> {
    return this.fs.computeHash(path);
  }
}
