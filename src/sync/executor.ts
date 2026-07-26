import { dropboxContentHashBrowser } from "../hash.browser";
import type {
  FileSystem,
  RemoteDeleteBatchEntryResult,
  RemoteListedFile,
  RemoteStorage,
  SyncStateStore,
} from "../adapters/interfaces";
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
import {
  hasNestedOtherFilesPath,
  SyncHypotheses,
  type SyncMonitorLog,
} from "../debug/sync-monitor";
import {
  coalesceDeleteRemote,
  type CoalesceDeleteRemoteResult,
} from "./delete-coalesce";

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
   * Non-deleted remote file path_lowers for this cycle — used to coalesce
   * complete deleteRemote subtrees into folder deletes before delete_batch.
   */
  existingRemotePathLowers?: Iterable<string>;
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
  /** Structured sync monitor (optional; tests omit). */
  log?: SyncMonitorLog;
  /** 라이브 리포트: 실행 항목 시작/종료 */
  onExecItem?: (
    localPath: string,
    actionType: string,
    event: "start" | "end",
    ok?: boolean,
    error?: string,
  ) => void;
}

/** Log items slower than this as stall candidates (permanent monitor). */
const SLOW_ITEM_LOG_MS = 5_000;

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

  // Peel deleteRemote into a dedicated batch/coalesce pass (no per-item soft timeout).
  const deleteRemoteItems: SyncPlanItem[] = [];
  const nonDeleteRemoteExecutable: SyncPlanItem[] = [];
  for (const item of executable) {
    if (item.action.type === "deleteRemote") {
      deleteRemoteItems.push(item);
    } else {
      nonDeleteRemoteExecutable.push(item);
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

  ctx.log?.("executor batch start", {
    executable: executable.length,
    deleteRemote: deleteRemoteItems.length,
    conflicts: conflicts.length,
    deferred: deferred.length,
    concurrency,
    itemTimeoutMs,
  }, { hypothesisId: SyncHypotheses.sync, location: "executor.executePlan" });

  // Remote deletes first: folder coalesce + delete_batch, then expand to file items.
  if (deleteRemoteItems.length > 0 && !ctx.signal?.aborted) {
    const blockingPathLowers = [
      ...nonDeleteRemoteExecutable.map((item) => item.pathLower),
      ...conflicts.map((item) => item.pathLower),
      ...deferred.map((item) => item.pathLower),
    ];
    const remoteDeleteResult = await executeDeleteRemoteBatch(
      deleteRemoteItems,
      ctx,
      blockingPathLowers,
      { onItemSettled: () => bumpProgress() },
    );
    succeeded.push(...remoteDeleteResult.succeeded);
    failed.push(...remoteDeleteResult.failed);
  } else if (deleteRemoteItems.length > 0) {
    for (const item of deleteRemoteItems) {
      failed.push({
        item,
        error: new Error("Aborted before deleteRemote batch"),
      });
      bumpProgress();
    }
  }

  // Pass 1: parallel batch for non-deleteRemote work. Timeouts free slots so other files keep moving.
  const pass1 = await runExecutableBatch(
    nonDeleteRemoteExecutable,
    ctx,
    concurrency,
    itemTimeoutMs,
    {
      // Only count successes/failures toward progress in pass 1; timeouts retry later.
      onSettled: (kind) => {
        if (kind !== "timeout") bumpProgress();
      },
    },
  );
  succeeded.push(...pass1.succeeded);
  failed.push(...pass1.failed);
  if (pass1.timedOut.length > 0) {
    // #region agent log
    ctx.log?.("executor pass1 timeouts", {
      count: pass1.timedOut.length,
      sample: pass1.timedOut.slice(0, 8).map((i) => `${i.action.type}:${i.localPath}`),
      itemTimeoutMs,
    }, { hypothesisId: SyncHypotheses.itemStall, location: "executor.executePlan" });
    // #endregion
  }

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
      // #region agent log
      ctx.log?.("executor item timed out after retry", {
        action: item.action.type,
        path: item.localPath,
        itemTimeoutMs,
      }, { hypothesisId: SyncHypotheses.itemStall, location: "executor.executePlan" });
      // #endregion
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

/**
 * Live-verify coalesced folder deletes against Dropbox before recursive wipe.
 * Exact child-set match required; content_hash ≠ base → download that path instead.
 */
async function verifyCoalescedFolderDeletes(
  coalesce: CoalesceDeleteRemoteResult,
  remote: RemoteStorage,
  store: SyncStateStore,
  log?: SyncMonitorLog,
): Promise<{
  folderPaths: string[];
  folderToCoveredItems: Map<string, SyncPlanItem[]>;
  remainingFileItems: SyncPlanItem[];
  downloadItems: SyncPlanItem[];
}> {
  const folderPaths: string[] = [];
  const folderToCoveredItems = new Map<string, SyncPlanItem[]>();
  const remainingFileItems = [...coalesce.remainingFileItems];
  const downloadItems: SyncPlanItem[] = [];

  for (const folder of coalesce.folderPaths) {
    const covered = coalesce.folderToCoveredItems.get(folder.toLowerCase())
      ?? coalesce.folderToCoveredItems.get(folder)
      ?? [];
    const planned = new Set(covered.map((item) => item.pathLower));

    let live: RemoteListedFile[];
    try {
      live = await remote.listFilePathLowersUnder(folder);
    } catch (e) {
      log?.("exec folder verify list failed — expanding to files", {
        folder,
        error: e instanceof Error ? e.message : String(e),
        covered: covered.length,
      }, { hypothesisId: SyncHypotheses.deleteNotExecuted, location: "executor.verifyFolder" });
      remainingFileItems.push(...covered);
      continue;
    }

    const livePaths = new Set(live.map((f) => f.pathLower));
    const setsEqual =
      livePaths.size === planned.size
      && [...planned].every((pathLower) => livePaths.has(pathLower));

    if (!setsEqual) {
      log?.("exec folder verify set mismatch — file deletes only", {
        folder,
        planned: planned.size,
        live: livePaths.size,
      }, { hypothesisId: SyncHypotheses.deleteNotExecuted, location: "executor.verifyFolder" });
      remainingFileItems.push(...covered);
      continue;
    }

    const hashByPath = new Map(live.map((f) => [f.pathLower, f.contentHash]));
    const mismatched: SyncPlanItem[] = [];
    const matched: SyncPlanItem[] = [];
    for (const item of covered) {
      const base = await store.getEntry(item.pathLower);
      const liveHash = hashByPath.get(item.pathLower) ?? "";
      // Modification beats delete at execute time — same intent as planner.
      if (base?.baseRemoteHash && liveHash && liveHash !== base.baseRemoteHash) {
        mismatched.push(item);
      } else {
        matched.push(item);
      }
    }

    if (mismatched.length > 0) {
      log?.("exec folder verify hash mismatch — download changed, file-delete rest", {
        folder,
        mismatched: mismatched.length,
        matched: matched.length,
      }, { hypothesisId: SyncHypotheses.deleteNotExecuted, location: "executor.verifyFolder" });
      for (const item of mismatched) {
        item.action = {
          type: "download",
          reason: "remote_modified_local_deleted",
        };
        downloadItems.push(item);
      }
      remainingFileItems.push(...matched);
      continue;
    }

    folderPaths.push(folder);
    folderToCoveredItems.set(folder.toLowerCase(), covered);
  }

  return {
    folderPaths,
    folderToCoveredItems,
    remainingFileItems,
    downloadItems,
  };
}

/**
 * Coalesce complete remote delete subtrees into folder deletes, then run
 * remote.deleteBatch. Results are expanded back to the original file-level
 * SyncPlanItems so delete-log clearing and UI counts stay unchanged.
 * On whole-batch transport/job failure, falls back to per-item remote.delete.
 */
async function executeDeleteRemoteBatch(
  deleteRemoteItems: SyncPlanItem[],
  ctx: ExecutorContext,
  blockingPathLowers: Iterable<string>,
  hooks: { onItemSettled: () => void },
): Promise<{
  succeeded: SyncPlanItem[];
  failed: { item: SyncPlanItem; error: Error }[];
}> {
  const succeeded: SyncPlanItem[] = [];
  const failed: { item: SyncPlanItem; error: Error }[] = [];

  const settleItem = async (
    item: SyncPlanItem,
    ok: boolean,
    error?: Error,
  ): Promise<void> => {
    const actionType = "deleteRemote";
    ctx.onExecItem?.(item.localPath, actionType, "start");
    ctx.ctx?.emit({
      type: "exec_start",
      ts: Date.now(),
      pathLower: item.pathLower,
      action: actionType,
    });
    if (ok) {
      try {
        await ctx.store.deleteEntry(item.pathLower);
      } catch (storeErr) {
        const err = storeErr instanceof Error ? storeErr : new Error(String(storeErr));
        ctx.onExecItem?.(item.localPath, actionType, "end", false, err.message);
        failed.push({ item, error: err });
        hooks.onItemSettled();
        return;
      }
      ctx.onExecItem?.(item.localPath, actionType, "end", true);
      ctx.ctx?.emit({
        type: "exec_end",
        ts: Date.now(),
        pathLower: item.pathLower,
        action: actionType,
        ok: true,
        duration: 0,
      });
      succeeded.push(item);
    } else {
      const err = error ?? new Error("deleteRemote failed");
      ctx.onExecItem?.(item.localPath, actionType, "end", false, err.message);
      ctx.ctx?.emit({
        type: "exec_end",
        ts: Date.now(),
        pathLower: item.pathLower,
        action: actionType,
        ok: false,
        error: err.message,
        duration: 0,
      });
      failed.push({ item, error: err });
    }
    hooks.onItemSettled();
  };

  /** Per-item delete_v2 fallback — executeItem owns store cleanup + not_found soft-ok. */
  const fallbackPerItem = async (items: SyncPlanItem[]): Promise<void> => {
    for (const item of items) {
      if (ctx.signal?.aborted) {
        await settleItem(item, false, new Error("Aborted during deleteRemote fallback"));
        continue;
      }
      // Skip items already reclassified to download during folder verify.
      if (item.action.type !== "deleteRemote") {
        continue;
      }
      const actionType = "deleteRemote";
      ctx.onExecItem?.(item.localPath, actionType, "start");
      try {
        await executeItem(item, ctx);
        ctx.onExecItem?.(item.localPath, actionType, "end", true);
        succeeded.push(item);
        hooks.onItemSettled();
      } catch (itemErr) {
        const err = itemErr instanceof Error ? itemErr : new Error(String(itemErr));
        ctx.onExecItem?.(item.localPath, actionType, "end", false, err.message);
        failed.push({ item, error: err });
        hooks.onItemSettled();
      }
    }
  };

  const coalesce = coalesceDeleteRemote({
    deleteRemoteItems,
    existingRemotePathLowers: ctx.existingRemotePathLowers ?? [],
    blockingPathLowers,
  });

  const verified = await verifyCoalescedFolderDeletes(
    coalesce,
    ctx.remote,
    ctx.store,
    ctx.log,
  );

  // Restore remotely-edited files before any sibling deletes under the same tree.
  for (const item of verified.downloadItems) {
    if (ctx.signal?.aborted) {
      failed.push({ item, error: new Error("Aborted during deleteRemote hash rescue download") });
      hooks.onItemSettled();
      continue;
    }
    const actionType = "download";
    ctx.onExecItem?.(item.localPath, actionType, "start");
    try {
      await executeItem(item, ctx);
      ctx.onExecItem?.(item.localPath, actionType, "end", true);
      succeeded.push(item);
      hooks.onItemSettled();
    } catch (itemErr) {
      const err = itemErr instanceof Error ? itemErr : new Error(String(itemErr));
      ctx.onExecItem?.(item.localPath, actionType, "end", false, err.message);
      failed.push({ item, error: err });
      hooks.onItemSettled();
    }
  }

  // Folders first, then remaining files — never both a folder and its children.
  const requestPaths = [
    ...verified.folderPaths,
    ...verified.remainingFileItems.map((item) => item.localPath),
  ];
  const folderSet = new Set(verified.folderPaths.map((p) => p.toLowerCase()));
  const fileItemByPath = new Map(
    verified.remainingFileItems.map((item) => [item.pathLower, item]),
  );

  ctx.log?.("exec deleteRemote batch start", {
    fileItems: deleteRemoteItems.length,
    folderPaths: verified.folderPaths.length,
    remainingFiles: verified.remainingFileItems.length,
    rescuedDownloads: verified.downloadItems.length,
    requestPaths: requestPaths.length,
  }, { hypothesisId: SyncHypotheses.deleteNotExecuted, location: "executor.deleteRemoteBatch" });

  if (requestPaths.length === 0) {
    return { succeeded, failed };
  }

  let batchResults: RemoteDeleteBatchEntryResult[];
  try {
    batchResults = await ctx.remote.deleteBatch(requestPaths);
  } catch (e) {
    ctx.log?.("exec deleteRemote batch failed — falling back to per-item", {
      error: e instanceof Error ? e.message : String(e),
      count: verified.remainingFileItems.length + verified.folderPaths.length,
    }, { hypothesisId: SyncHypotheses.deleteNotExecuted, location: "executor.deleteRemoteBatch" });
    // Only fall back deletes still planned — rescued downloads already ran.
    const deleteFallback = [
      ...verified.remainingFileItems,
      ...[...verified.folderToCoveredItems.values()].flat(),
    ];
    await fallbackPerItem(deleteFallback);
    return { succeeded, failed };
  }

  // Expand folder too_many_files into a follow-up file batch.
  const expandFileItems: SyncPlanItem[] = [];
  const pendingFileSettlements: Array<{
    item: SyncPlanItem;
    result: RemoteDeleteBatchEntryResult;
  }> = [];

  for (let i = 0; i < requestPaths.length; i++) {
    const path = requestPaths[i]!;
    const pathLower = path.toLowerCase();
    const result = batchResults[i] ?? {
      path,
      ok: false,
      error: new Error("Missing delete_batch result entry"),
    };

    if (folderSet.has(pathLower)) {
      const covered = verified.folderToCoveredItems.get(pathLower) ?? [];
      if (result.ok) {
        for (const item of covered) {
          await settleItem(item, true);
        }
      } else if (result.tooManyFiles) {
        expandFileItems.push(...covered);
      } else {
        for (const item of covered) {
          await settleItem(item, false, result.error);
        }
      }
      continue;
    }

    const item = fileItemByPath.get(pathLower);
    if (!item) continue;
    pendingFileSettlements.push({ item, result });
  }

  for (const { item, result } of pendingFileSettlements) {
    await settleItem(item, result.ok, result.error);
  }

  if (expandFileItems.length > 0 && !ctx.signal?.aborted) {
    ctx.log?.("exec deleteRemote expanding too_many_files folders", {
      count: expandFileItems.length,
    }, { hypothesisId: SyncHypotheses.deleteNotExecuted, location: "executor.deleteRemoteBatch" });
    try {
      const expandResults = await ctx.remote.deleteBatch(
        expandFileItems.map((item) => item.localPath),
      );
      for (let i = 0; i < expandFileItems.length; i++) {
        const item = expandFileItems[i]!;
        const result = expandResults[i] ?? {
          path: item.localPath,
          ok: false,
          error: new Error("Missing delete_batch expand result"),
        };
        await settleItem(item, result.ok, result.error);
      }
    } catch {
      await fallbackPerItem(expandFileItems);
    }
  }

  return { succeeded, failed };
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
    const isDelete = actionType === "deleteRemote" || actionType === "deleteLocal";
    ctx.onExecItem?.(item.localPath, actionType, "start");
    ctx.ctx?.emit({ type: "exec_start", ts: Date.now(), pathLower: item.pathLower, action: actionType });
    if (isDelete) {
      ctx.log?.("exec delete start", {
        action: actionType,
        path: item.localPath,
      }, { hypothesisId: SyncHypotheses.deleteNotExecuted, location: "executor.item" });
    }
    const start = Date.now();
    try {
      await raceWithTimeout(executeItem(item, ctx), itemTimeoutMs, ctx.signal);
      const durationMs = Date.now() - start;
      ctx.onExecItem?.(item.localPath, actionType, "end", true);
      ctx.ctx?.emit({ type: "exec_end", ts: Date.now(), pathLower: item.pathLower, action: actionType, ok: true, duration: durationMs });
      if (isDelete) {
        ctx.log?.("exec delete ok", {
          action: actionType,
          path: item.localPath,
          durationMs,
        }, { hypothesisId: SyncHypotheses.deleteNotExecuted, location: "executor.item" });
      } else if (durationMs >= SLOW_ITEM_LOG_MS) {
        ctx.log?.("exec item slow", {
          action: actionType,
          path: item.localPath,
          durationMs,
        }, { hypothesisId: SyncHypotheses.itemStall, location: "executor.item" });
      }
      // Progress must advance as each item finishes — not after the whole batch
      // (otherwise the explorer bar stays at 0/N until the end).
      hooks.onSettled("success");
    } catch (e) {
      const errMsg = (e as Error).message;
      const durationMs = Date.now() - start;
      ctx.onExecItem?.(item.localPath, actionType, "end", false, errMsg);
      ctx.ctx?.emit({ type: "exec_end", ts: Date.now(), pathLower: item.pathLower, action: actionType, ok: false, error: errMsg, duration: durationMs });
      if (isDelete || e instanceof ItemTimeoutError || durationMs >= SLOW_ITEM_LOG_MS) {
        ctx.log?.("exec item failed", {
          action: actionType,
          path: item.localPath,
          durationMs,
          error: errMsg,
          errorName: (e as Error).name,
          timedOut: e instanceof ItemTimeoutError,
        }, {
          hypothesisId: e instanceof ItemTimeoutError
            ? SyncHypotheses.itemStall
            : isDelete
              ? SyncHypotheses.deleteNotExecuted
              : SyncHypotheses.itemStall,
          location: "executor.item",
        });
      }
      // Mirror success path: notify UI/timeout accounting before rethrowing to the pool.
      if (e instanceof ItemTimeoutError) {
        hooks.onSettled("timeout");
      } else {
        hooks.onSettled("failure");
      }
      throw e;
    }
  });

  const settled = await runWithConcurrency(tasks, concurrency, {
    signal: ctx.signal,
  });

  // Collect outcomes only — onSettled already ran per-item so the progress bar moves live.
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (!r) continue;
    if (r.status === "fulfilled") {
      succeeded.push(items[i]);
    } else if (r.reason instanceof ItemTimeoutError) {
      timedOut.push(items[i]);
    } else {
      failed.push({ item: items[i], error: r.reason as Error });
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

/** Dropbox delete/lookup 409 when the path is already gone (path_lookup/not_found). */
function isDropboxPathNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("not_found");
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
            const conflictResult = await dispatchConflict(item, conflictCtx);
            if (conflictResult.conflictSiblingPath) {
              item.conflictSiblingPath = conflictResult.conflictSiblingPath;
            }
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
      try {
        await remote.delete(localPath);
      } catch (err) {
        // Dropbox 409 path_lookup/not_found: remote already gone. Treat as success
        // so stale delete intents (Ink/.writing, etc.) don't fail the cycle, stick
        // in the delete log, or block cursor finalize. Confirmed on iPad logs.
        if (!isDropboxPathNotFoundError(err)) {
          throw err;
        }
        deps.log?.("deleteRemote already absent — treating as success", {
          path: localPath,
          nestedOtherFiles: hasNestedOtherFilesPath(localPath),
          error: err instanceof Error ? err.message : String(err),
        }, { hypothesisId: SyncHypotheses.deleteNotExecuted, location: "executor.deleteRemote" });
        // #region agent log
        if (hasNestedOtherFilesPath(localPath)) {
          deps.log?.("H-path: nested Other/Files path already absent on remote", {
            path: localPath,
            pathLower,
          }, { hypothesisId: SyncHypotheses.pathShape, location: "executor.deleteRemote" });
        }
        // #endregion
      }
      await store.deleteEntry(pathLower);
      break;
    }

    case "conflict": {
      const conflictResult = await dispatchConflict(item, conflictCtx);
      if (conflictResult.conflictSiblingPath) {
        item.conflictSiblingPath = conflictResult.conflictSiblingPath;
      }
      break;
    }

    case "noop":
      break;
  }
}

// Re-export for backward compatibility (tests, engine 등에서 import)
export { makeConflictPath } from "./conflict-handlers";
