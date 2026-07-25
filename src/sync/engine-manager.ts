import type { FileSystem, RemoteStorage, SyncStateStore } from "../adapters/interfaces";
import { SyncEngine, type SyncEngineOptions } from "./engine";

export interface EngineManagerConfig {
  createDeps: () => { fs: FileSystem; remote: RemoteStorage; store: SyncStateStore };
  getOptions: () => SyncEngineOptions;
}

/**
 * SyncEngine의 생명주기 관리.
 *
 * - getOrCreate(): 엔진이 없으면 생성, 있으면 재사용
 * - reset(): 설정 변경 시 엔진 재생성 (deleteLog 보존)
 * - clearSyncHistory(): wipe store + delete intents (unlike reset, does not preserve deleteLog)
 * - store/remote: 외부에서 참조 가능
 */
export class EngineManager {
  private engine: SyncEngine | null = null;
  private deps: { fs: FileSystem; remote: RemoteStorage; store: SyncStateStore } | null = null;
  private pendingDeleteLog: string[] = [];

  constructor(private config: EngineManagerConfig) {}

  getOrCreate(): SyncEngine {
    if (this.engine) return this.engine;

    this.deps = this.config.createDeps();
    this.engine = new SyncEngine(this.deps, this.config.getOptions());

    if (this.pendingDeleteLog.length > 0) {
      this.engine.restoreDeleteLog(this.pendingDeleteLog);
      this.pendingDeleteLog = [];
    }

    return this.engine;
  }

  reset(): void {
    if (this.engine) {
      this.pendingDeleteLog = this.engine.getDeleteLog();
      this.persistDeleteLog();
    }
    this.engine = null;
    this.deps = null;
  }

  /**
   * Treat this device like a first install for planning: empty sync base, cursor,
   * and delete log only. Must not touch data.json (incl. debugLoggingEnabled),
   * device-local Cursor Debug ingest fields, debug log files, OAuth, or vault files.
   * Drops the engine afterward so the next cycle does not rehydrate delete intents.
   */
  async clearSyncHistory(): Promise<void> {
    this.pendingDeleteLog = [];
    const engine = this.getOrCreate();
    const store = this.deps?.store;
    if (!store) {
      throw new Error("Sync state store is not available");
    }
    engine.clearDeleteLog();
    await store.clear();
    this.engine = null;
    this.deps = null;
  }

  get fs(): FileSystem | null {
    return this.deps?.fs ?? null;
  }

  get store(): SyncStateStore | null {
    return this.deps?.store ?? null;
  }

  get remote(): RemoteStorage | null {
    return this.deps?.remote ?? null;
  }

  hasPendingDeletes(): boolean {
    return this.engine?.hasPendingDeletes() ?? false;
  }

  persistDeleteLog(): void {
    if (!this.engine || !this.deps?.store) return;
    const log = this.engine.getDeleteLog();
    this.deps.store.setMeta("deleteLog", JSON.stringify(log)).catch((e) => {
      console.error("Failed to persist delete log:", e);
    });
  }

  async restoreDeleteLog(): Promise<void> {
    const store = this.deps?.store;
    if (!store || !this.engine) return;
    const saved = await store.getMeta("deleteLog");
    if (saved) {
      try {
        this.engine.restoreDeleteLog(JSON.parse(saved) as string[]);
      } catch (e) {
        console.error("Failed to restore delete log:", e);
      }
    }
  }
}
