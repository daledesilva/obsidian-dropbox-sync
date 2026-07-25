import type { SyncPlanItem, SyncResult } from "../types";

/**
 * Per-path UI status for the status bar (active file only).
 * Idle synced files have no record → status bar stays hidden.
 */
export type FileSyncUiStatus =
  | "pending"
  | "syncing"
  | "success"
  | "error"
  | "conflict";

export interface FileSyncStatusRecord {
  status: FileSyncUiStatus;
  /** Short detail for aria / error messages. */
  detail?: string;
  /** keep_both sibling path when status is conflict. */
  conflictSiblingPath?: string;
  updatedAt: number;
}

export type FileSyncStatusListener = () => void;

const SUCCESS_CLEAR_MS = 5000;

/**
 * In-memory map of vault-relative path → sync UI status.
 * Success auto-clears per path after a short confirmation window.
 */
export class FileSyncStatusTracker {
  private records = new Map<string, FileSyncStatusRecord>();
  private successTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private listeners = new Set<FileSyncStatusListener>();

  subscribe(listener: FileSyncStatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(path: string): FileSyncStatusRecord | undefined {
    return this.records.get(normalizePathKey(path));
  }

  markPending(path: string, detail?: string): void {
    this.setRecord(path, {
      status: "pending",
      detail,
      updatedAt: Date.now(),
    });
  }

  markSyncing(path: string, detail?: string): void {
    this.setRecord(path, {
      status: "syncing",
      detail,
      updatedAt: Date.now(),
    });
  }

  markSuccess(path: string, detail?: string): void {
    const key = normalizePathKey(path);
    this.setRecord(path, {
      status: "success",
      detail,
      updatedAt: Date.now(),
    });
    this.clearSuccessTimer(key);
    this.successTimers.set(
      key,
      setTimeout(() => {
        this.successTimers.delete(key);
        const current = this.records.get(key);
        if (current?.status === "success") {
          this.records.delete(key);
          this.notify();
        }
      }, SUCCESS_CLEAR_MS),
    );
  }

  markError(path: string, detail?: string): void {
    this.setRecord(path, {
      status: "error",
      detail,
      updatedAt: Date.now(),
    });
  }

  markConflict(path: string, conflictSiblingPath: string, detail?: string): void {
    this.setRecord(path, {
      status: "conflict",
      detail,
      conflictSiblingPath,
      updatedAt: Date.now(),
    });
  }

  clearPath(path: string): void {
    const key = normalizePathKey(path);
    this.clearSuccessTimer(key);
    if (this.records.delete(key)) this.notify();
  }

  /** Abort: in-flight paths go back to pending so the status bar stays meaningful. */
  requeueSyncing(detail?: string): void {
    this.mapSyncingTo("pending", detail);
  }

  /** Cycle-level failure: in-flight paths surface as errors. */
  failSyncing(detail?: string): void {
    this.mapSyncingTo("error", detail);
  }

  private mapSyncingTo(status: "pending" | "error", detail?: string): void {
    let changed = false;
    for (const [key, record] of this.records) {
      if (record.status !== "syncing") continue;
      this.clearSuccessTimer(key);
      this.records.set(key, {
        status,
        detail,
        updatedAt: Date.now(),
      });
      changed = true;
    }
    if (changed) this.notify();
  }

  /** Move status when the vault renames a file. */
  renamePath(oldPath: string, newPath: string): void {
    const oldKey = normalizePathKey(oldPath);
    const newKey = normalizePathKey(newPath);
    const record = this.records.get(oldKey);
    this.clearSuccessTimer(oldKey);
    this.records.delete(oldKey);
    if (!record) {
      this.notify();
      return;
    }
    this.clearSuccessTimer(newKey);
    this.records.set(newKey, { ...record, updatedAt: Date.now() });
    if (record.status === "success") {
      this.successTimers.set(
        newKey,
        setTimeout(() => {
          this.successTimers.delete(newKey);
          const current = this.records.get(newKey);
          if (current?.status === "success") {
            this.records.delete(newKey);
            this.notify();
          }
        }, SUCCESS_CLEAR_MS),
      );
    }
    this.notify();
  }

  /** Mark every actionable plan path as syncing (cycle about to execute). */
  markPlanSyncing(items: SyncPlanItem[]): void {
    let changed = false;
    for (const item of items) {
      if (item.action.type === "noop") continue;
      const key = normalizePathKey(item.localPath);
      this.clearSuccessTimer(key);
      this.records.set(key, {
        status: "syncing",
        detail: "File is currently syncing with Dropbox",
        updatedAt: Date.now(),
      });
      changed = true;
    }
    if (changed) this.notify();
  }

  /**
   * Apply terminal outcomes from a SyncResult.
   * Conflict with a sibling → conflict; other successes → success; failures → error.
   * Deferred items stay pending so a later cycle can finish them.
   */
  applySyncResult(result: SyncResult): void {
    for (const item of result.succeeded) {
      if (item.action.type === "noop") continue;
      // keep_both (and rev-conflict→keep_both) attach the sibling path on the item.
      if (item.conflictSiblingPath) {
        this.markConflict(
          item.localPath,
          item.conflictSiblingPath,
          "Local and Dropbox both changed — click for details",
        );
        continue;
      }
      this.markSuccess(item.localPath, "File synced with Dropbox");
    }

    for (const { item, error } of result.failed) {
      this.markError(
        item.localPath,
        error?.message ? `Sync failed: ${error.message}` : "Sync failed for this file",
      );
    }

    for (const item of result.deferred) {
      this.markPending(
        item.localPath,
        "File has changes waiting to sync (open file was protected)",
      );
    }
  }

  destroy(): void {
    for (const timer of this.successTimers.values()) clearTimeout(timer);
    this.successTimers.clear();
    this.records.clear();
    this.listeners.clear();
  }

  private setRecord(path: string, record: FileSyncStatusRecord): void {
    const key = normalizePathKey(path);
    this.clearSuccessTimer(key);
    this.records.set(key, record);
    this.notify();
  }

  private clearSuccessTimer(key: string): void {
    const timer = this.successTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.successTimers.delete(key);
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

function normalizePathKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}
