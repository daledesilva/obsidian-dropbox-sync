import { dropboxContentHashBrowser } from "../hash.browser";
import type { FileSystem, RemoteStorage, SyncStateStore } from "../adapters/interfaces";
import { RevConflictError, type ConflictResolver, type ConflictStrategy, type SyncPlan, type SyncPlanItem, type SyncResult } from "../types";
import { assertValidSyncPath } from "./path-assert";
import { runWithConcurrency } from "./concurrency";
import {
  ConflictSkippedError,
  downloadAndVerify,
  updateSyncState,
  dispatchConflict,
} from "./conflict-handlers";
import type { ConflictHandlerDeps } from "./conflict-handlers";
import type { CycleContext } from "./cycle-context";

export interface ExecutorDeps {
  fs: FileSystem;
  remote: RemoteStorage;
  store: SyncStateStore;
}

export interface ExecutorConfig {
  conflictStrategy?: ConflictStrategy;
  conflictResolver?: ConflictResolver;
  /** 파일이 현재 편집 중인지 확인. true면 download/conflict를 건너뛴다 */
  isFileActive?: (path: string) => boolean;
  /** 중단 시그널. aborted 시 나머지 항목 건너뛴다 */
  signal?: AbortSignal;
  /** 병렬 실행 동시성. 기본값 1 (순차) */
  concurrency?: number;
  /** 항목 실행 완료 시마다 호출. (완료 수, 전체 수) */
  onProgress?: (completed: number, total: number) => void;
  /** conflict 직렬 실행 전 호출. conflict 총 수 전달. */
  onConflictCount?: (count: number) => void;
  /** deleteLocal 실행 직전 호출. vault 이벤트에서 구분하기 위해 pathLower 전달. */
  onBeforeDeleteLocal?: (pathLower: string) => void;
  /**
   * Per-item soft timeout (ms). Timed-out items free their concurrency slot and are
   * retried once at the end so slow/hanging files do not stall the rest of the plan.
   * 0 disables. Default 90_000.
   */
  itemTimeoutMs?: number;
  /** 사이클 컨텍스트 (execution trace) */
  ctx?: CycleContext;
  /** iOS/모바일 등 로컬 경로 규칙 적용 */
  strictLocalPaths?: boolean;
  /** 라이브 리포트: 실행 항목 시작/종료 */
  onExecItem?: (
    localPath: string,
    actionType: string,
    event: "start" | "end",
    ok?: boolean,
    error?: string,
  ) => void;
}

/** 내부 함수에서 사용하는 통합 컨텍스트 */
type ExecutorContext = ExecutorDeps & ExecutorConfig;

/** Thrown when a single plan item exceeds itemTimeoutMs. */
export class ItemTimeoutError extends Error {
  constructor(message = "Item timed out") {
    super(message);
    this.name = "ItemTimeoutError";
  }
}

const DEFAULT_ITEM_TIMEOUT_MS = 90_000;

/**
 * SyncPlan의 각 항목을 실행한다.
 *
 * - 항목별로 독립 실행 (하나 실패해도 나머지 계속)
 * - Slow/hanging items time out, free a worker slot, and retry once at the end
 * - upload 시 rev 충돌 → conflict로 재분류
 * - download 후 hash 검증
 */
export async function executePlan(
  plan: SyncPlan,
  deps: ExecutorDeps,
  config: ExecutorConfig = {},
): Promise<SyncResult> {
  const ctx: ExecutorContext = { ...deps, ...config };
  const deferred: SyncPlanItem[] = [];

  // 활성 파일 보호 + conflict 분리
  const executable: SyncPlanItem[] = [];
  const conflicts: SyncPlanItem[] = [];
  for (const item of plan.items) {
    const t = item.action.type;
    if (
      (t === "download" || t === "conflict" || t === "deleteLocal") &&
      ctx.isFileActive?.(item.localPath)
    ) {
      deferred.push(item);
    } else if (t === "conflict" && ctx.conflictStrategy === "manual") {
      conflicts.push(item);
    } else {
      executable.push(item);
    }
  }

  const concurrency = ctx.concurrency ?? 1;
  const itemTimeoutMs = ctx.itemTimeoutMs ?? DEFAULT_ITEM_TIMEOUT_MS;
  let completed = 0;
  // Progress denominator counts each item once (retry does not inflate total).
  const total = executable.length + conflicts.length;

  const succeeded: SyncPlanItem[] = [];
  const failed: { item: SyncPlanItem; error: Error }[] = [];

  // Seed 0/N so the active segment leaves indeterminate full-fill as soon as execute starts.
  ctx.onProgress?.(0, total);

  const bumpProgress = () => {
    completed++;
    ctx.onProgress?.(completed, total);
  };

  // Pass 1: parallel batch. Timeouts free slots so other files keep moving.
  const pass1 = await runExecutableBatch(executable, ctx, concurrency, itemTimeoutMs, {
    // Only count successes/failures toward progress in pass 1; timeouts retry later.
    onSettled: (kind) => {
      if (kind !== "timeout") bumpProgress();
    },
  });
  succeeded.push(...pass1.succeeded);
  failed.push(...pass1.failed);

  // Pass 2: push timed-out items to the back and retry once after faster work finishes.
  if (pass1.timedOut.length > 0 && !ctx.signal?.aborted) {
    const pass2 = await runExecutableBatch(pass1.timedOut, ctx, concurrency, itemTimeoutMs, {
      onSettled: () => bumpProgress(),
    });
    succeeded.push(...pass2.succeeded);
    failed.push(...pass2.failed);
    for (const item of pass2.timedOut) {
      failed.push({
        item,
        error: new ItemTimeoutError(`Timed out after ${itemTimeoutMs}ms (retry)`),
      });
      bumpProgress();
    }
  } else if (pass1.timedOut.length > 0) {
    for (const item of pass1.timedOut) {
      failed.push({
        item,
        error: new ItemTimeoutError(`Timed out after ${itemTimeoutMs}ms`),
      });
      bumpProgress();
    }
  }

  // conflict 항목: 직렬 (모달이 순차적으로 뜨도록)
  if (conflicts.length > 0) {
    ctx.onConflictCount?.(conflicts.length);
  }
  for (const item of conflicts) {
    if (ctx.signal?.aborted) break;
    const actionType = item.action.type;
    ctx.onExecItem?.(item.localPath, actionType, "start");
    ctx.ctx?.emit({ type: "exec_start", ts: Date.now(), pathLower: item.pathLower, action: actionType });
    const start = Date.now();
    try {
      await executeItem(item, ctx);
      ctx.onExecItem?.(item.localPath, actionType, "end", true);
      ctx.ctx?.emit({ type: "exec_end", ts: Date.now(), pathLower: item.pathLower, action: actionType, ok: true, duration: Date.now() - start });
      succeeded.push(item);
    } catch (e) {
      if (e instanceof ConflictSkippedError) {
        ctx.onExecItem?.(item.localPath, actionType, "end", true);
        ctx.ctx?.emit({ type: "exec_end", ts: Date.now(), pathLower: item.pathLower, action: actionType, ok: true, duration: Date.now() - start });
        deferred.push(item);
      } else {
        const errMsg = (e as Error).message;
        ctx.onExecItem?.(item.localPath, actionType, "end", false, errMsg);
        ctx.ctx?.emit({ type: "exec_end", ts: Date.now(), pathLower: item.pathLower, action: actionType, ok: false, error: errMsg, duration: Date.now() - start });
        failed.push({ item, error: e as Error });
      }
    }
    bumpProgress();
  }

  return { succeeded, failed, deferred };
}

type BatchSettleKind = "success" | "failure" | "timeout";

async function runExecutableBatch(
  items: SyncPlanItem[],
  ctx: ExecutorContext,
  concurrency: number,
  itemTimeoutMs: number,
  hooks: { onSettled: (kind: BatchSettleKind) => void },
): Promise<{
  succeeded: SyncPlanItem[];
  failed: { item: SyncPlanItem; error: Error }[];
  timedOut: SyncPlanItem[];
}> {
  const succeeded: SyncPlanItem[] = [];
  const failed: { item: SyncPlanItem; error: Error }[] = [];
  const timedOut: SyncPlanItem[] = [];
  if (items.length === 0) return { succeeded, failed, timedOut };

  const tasks = items.map((item) => async () => {
    const actionType = item.action.type;
    ctx.onExecItem?.(item.localPath, actionType, "start");
    ctx.ctx?.emit({ type: "exec_start", ts: Date.now(), pathLower: item.pathLower, action: actionType });
    const start = Date.now();
    try {
      await raceWithTimeout(executeItem(item, ctx), itemTimeoutMs, ctx.signal);
      ctx.onExecItem?.(item.localPath, actionType, "end", true);
      ctx.ctx?.emit({ type: "exec_end", ts: Date.now(), pathLower: item.pathLower, action: actionType, ok: true, duration: Date.now() - start });
    } catch (e) {
      const errMsg = (e as Error).message;
      ctx.onExecItem?.(item.localPath, actionType, "end", false, errMsg);
      ctx.ctx?.emit({ type: "exec_end", ts: Date.now(), pathLower: item.pathLower, action: actionType, ok: false, error: errMsg, duration: Date.now() - start });
      throw e;
    }
  });

  const settled = await runWithConcurrency(tasks, concurrency, {
    signal: ctx.signal,
  });

  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (!r) continue;
    if (r.status === "fulfilled") {
      succeeded.push(items[i]);
      hooks.onSettled("success");
    } else if (r.reason instanceof ItemTimeoutError) {
      timedOut.push(items[i]);
      hooks.onSettled("timeout");
    } else {
      failed.push({ item: items[i], error: r.reason as Error });
      hooks.onSettled("failure");
    }
  }

  return { succeeded, failed, timedOut };
}

/** Soft-timeout wrapper: frees the concurrency slot without cancelling the underlying I/O. */
async function raceWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  signal?: AbortSignal,
): Promise<T> {
  if (ms <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => {
    if (timer !== undefined) clearTimeout(timer);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ItemTimeoutError(`Timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function executeItem(
  item: SyncPlanItem,
  deps: ExecutorContext,
): Promise<void> {
  const { fs, remote, store } = deps;
  const { action, pathLower, localPath } = item;
  const conflictCtx: ConflictHandlerDeps = deps;

  switch (action.type) {
    case "upload": {
      assertValidSyncPath(localPath, deps.strictLocalPaths ?? false);

      const data = await fs.read(localPath);
      const localHash = await dropboxContentHashBrowser(data);

      const base = await store.getEntry(pathLower);
      const rev = base?.rev ?? undefined;

      let entry;
      try {
        entry = await remote.upload(localPath, data, rev);
      } catch (err) {
        if (err instanceof RevConflictError) {
          try {
            await dispatchConflict(item, conflictCtx);
          } catch (conflictErr) {
            // Remote file was deleted — stale rev is useless.
            // Upload fresh (no rev) to recover from the loop.
            if (conflictErr instanceof Error && conflictErr.message.includes("not_found")) {
              entry = await remote.upload(localPath, data);
              await updateSyncState(store, pathLower, localPath, localHash, entry.hash ?? localHash, entry.rev);
              return;
            }
            throw new Error(
              `Rev conflict for "${localPath}" and conflict resolution also failed: ${conflictErr instanceof Error ? conflictErr.message : String(conflictErr)}`,
            );
          }
          return;
        }
        throw err;
      }

      await updateSyncState(store, pathLower, localPath, localHash, entry.hash ?? localHash, entry.rev);
      break;
    }

    case "download": {
      assertValidSyncPath(localPath, deps.strictLocalPaths ?? false);

      const result = await downloadAndVerify(remote, localPath);
      await fs.write(localPath, result.data, result.metadata.serverModified);
      await updateSyncState(store, pathLower, localPath, result.verifiedHash, result.verifiedHash, result.metadata.rev);
      break;
    }

    case "deleteLocal": {
      deps.onBeforeDeleteLocal?.(pathLower);
      await fs.delete(localPath);
      await store.deleteEntry(pathLower);
      break;
    }

    case "deleteRemote": {
      await remote.delete(localPath);
      await store.deleteEntry(pathLower);
      break;
    }

    case "conflict": {
      await dispatchConflict(item, conflictCtx);
      break;
    }

    case "noop":
      break;
  }
}

// Re-export for backward compatibility (tests, engine 등에서 import)
export { makeConflictPath } from "./conflict-handlers";
