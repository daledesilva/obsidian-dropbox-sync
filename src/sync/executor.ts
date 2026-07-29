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
  updateSyncState,
  dispatchConflict,
  handleConflictKeepBoth,
  resolveConflictCopyPath,
} from "./conflict-handlers";
import type { ConflictHandlerDeps } from "./conflict-handlers";
import type { CycleContext } from "./cycle-context";
import {
  hasNestedOtherFilesPath,
  logRule,
  shortHash,
  SyncHypotheses,
  SyncLogCategories,
  SyncRules,
  type SyncMonitorLog,
} from "../debug/sync-monitor";
import {
  coalesceDeleteRemote,
  type CoalesceDeleteRemoteResult,
} from "./delete-coalesce";
import { logTemp } from "../debug/temp-log";
import type { DeferralTracker } from "./deferral-tracker";
import { ACTIVE_FILE_DEFERRAL_MS } from "./deferral-tracker";
import { moveRemotePath } from "./remote-move";
import { buildPathNotice } from "./path-notices";
import type { RemoteEntry } from "../types";

export interface ExecutorDeps {
  fs: FileSystem;
  remote: RemoteStorage;
  store: SyncStateStore;
}

export interface ExecutorConfig {
  conflictStrategy?: ConflictStrategy;
  conflictResolver?: ConflictResolver;
  /** Active file or dirty open tab — defer apply actions (G19/G10). */
  shouldDeferApply?: (path: string) => boolean;
  /** @deprecated Prefer shouldDeferApply. */
  isFileActive?: (path: string) => boolean;
  /** G21: deleteLocal while open — true deletes here, false keeps editing (defer). */
  confirmDeleteLocalWhileOpen?: (path: string) => Promise<boolean>;
  reloadOpenFile?: (path: string) => Promise<void>;
  deferralTracker?: DeferralTracker;
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
    action: { type: string; fromPath?: string; toPath?: string },
    event: "start" | "end",
    ok?: boolean,
    error?: string,
  ) => void;
  /** G13: path-specific Notice when a surprising reason completes successfully. */
  onPathNotice?: (message: string) => void;
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

// R12: do not rewrite an open/dirty editor mid-cycle — download, planned conflict
// apply, and deleteLocal wait for a later sync (or the deferral bound) instead.
const DEFERRABLE_APPLY_ACTIONS = new Set(["download", "conflict", "deleteLocal"]);

function resolveShouldDeferApply(ctx: ExecutorContext): ((path: string) => boolean) | undefined {
  return ctx.shouldDeferApply ?? ctx.isFileActive;
}

function shouldDeferProtectedItem(
  item: SyncPlanItem,
  ctx: ExecutorContext,
  now = Date.now(),
): boolean {
  const shouldDeferApply = resolveShouldDeferApply(ctx);
  if (!shouldDeferApply?.(item.localPath)) return false;
  // Uploads stay executable: open notes may still push local bytes; only inbound/conflict apply waits.
  if (!DEFERRABLE_APPLY_ACTIONS.has(item.action.type)) return false;

  const tracker = ctx.deferralTracker;
  if (!tracker) {
    return true;
  }

  if (tracker.boundExpired(item.localPath, now)) {
    logTemp(ctx.log, "P4", "deferral bound expired — applying", {
      path: item.localPath,
      action: item.action.type,
      elapsedMs: tracker.elapsedMs(item.localPath, now),
      boundMs: ACTIVE_FILE_DEFERRAL_MS,
    }, { location: "executor.shouldDeferProtectedItem" });
    tracker.clear(item.localPath);
    return false;
  }

  tracker.markDeferred(item.localPath, now);
  return true;
}

async function partitionPlanItems(
  plan: SyncPlan,
  ctx: ExecutorContext,
): Promise<{
  executable: SyncPlanItem[];
  conflicts: SyncPlanItem[];
  deferred: SyncPlanItem[];
}> {
  const deferred: SyncPlanItem[] = [];
  const executable: SyncPlanItem[] = [];
  const conflicts: SyncPlanItem[] = [];

  for (const item of plan.items) {
    const actionType = item.action.type;

    if (actionType === "deleteLocal" && resolveShouldDeferApply(ctx)?.(item.localPath)) {
      if (ctx.confirmDeleteLocalWhileOpen) {
        const deleteHere = await ctx.confirmDeleteLocalWhileOpen(item.localPath);
        if (!deleteHere) {
          if (shouldDeferProtectedItem(item, ctx)) {
            // Runbook-dependent log — do not remove: runbook 06 / 08 assert open-file deferral wording.
            logRule(ctx.log, SyncRules.R12, "deferring deleteLocal — keep editing", {
              path: item.localPath,
              action: actionType,
              bounded: true,
            }, { level: "info", location: "executor.partitionPlanItems" });
            deferred.push(item);
          } else {
            executable.push(item);
          }
          continue;
        }
        executable.push(item);
        continue;
      }
    }

    // Planned conflict while open: skip keep_both / Ask-me this cycle; retry on next sync.
    if (shouldDeferProtectedItem(item, ctx)) {
      // Runbook-dependent log — do not remove: runbook 08 expects this exact message with action: "conflict".
      logRule(ctx.log, SyncRules.R12, "deferring — file is open or dirty in editor", {
        path: item.localPath,
        action: actionType,
        bounded: !!ctx.deferralTracker,
      }, { level: "info", location: "executor.partitionPlanItems" });
      deferred.push(item);
    } else if (actionType === "conflict" && ctx.conflictStrategy === "manual") {
      conflicts.push(item);
    } else {
      executable.push(item);
    }
  }

  return { executable, conflicts, deferred };
}

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
  const { executable, conflicts, deferred: initiallyDeferred } = await partitionPlanItems(plan, ctx);
  const deferred: SyncPlanItem[] = [...initiallyDeferred];

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

  // Folder creates first at low concurrency — Dropbox write-locks the namespace; blasting
  // create_folder_v2 at full pool concurrency (8) with Retry-After:0 stampedes into 429s.
  const createRemoteFolders = nonDeleteRemoteExecutable.filter(
    (item) => item.action.type === "createRemoteFolder",
  );
  // Local folder deletes after file deletes — same-cycle remote folder wipe plans
  // deleteLocal children + deleteLocalFolder; emptying first avoids rmdir failures.
  const deleteLocalFolders = nonDeleteRemoteExecutable.filter(
    (item) => item.action.type === "deleteLocalFolder",
  );
  const nonFolderExecutable = nonDeleteRemoteExecutable.filter(
    (item) =>
      item.action.type !== "createRemoteFolder"
      && item.action.type !== "deleteLocalFolder",
  );
  // Serial mkdir — even 2 parallel create_folder_v2 calls still 429 under write locks.
  const folderConcurrency = 1;

  const folderPass = await runExecutableBatch(
    createRemoteFolders,
    ctx,
    folderConcurrency,
    itemTimeoutMs,
    {
      onSettled: (kind) => {
        if (kind !== "timeout") bumpProgress();
      },
    },
  );
  succeeded.push(...folderPass.succeeded);
  failed.push(...folderPass.failed);

  // Pass 1: parallel batch for remaining non-deleteRemote work (includes deleteLocal).
  const pass1 = await runExecutableBatch(
    nonFolderExecutable,
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

  const deleteLocalFolderPass = await runExecutableBatch(
    deleteLocalFolders,
    ctx,
    folderConcurrency,
    itemTimeoutMs,
    {
      onSettled: (kind) => {
        if (kind !== "timeout") bumpProgress();
      },
    },
  );
  succeeded.push(...deleteLocalFolderPass.succeeded);
  failed.push(...deleteLocalFolderPass.failed);

  const timedOutForRetry = [
    ...folderPass.timedOut,
    ...pass1.timedOut,
    ...deleteLocalFolderPass.timedOut,
  ];
  if (timedOutForRetry.length > 0) {
  }

  // Pass 2: push timed-out items to the back and retry once after faster work finishes.
  if (timedOutForRetry.length > 0 && !ctx.signal?.aborted) {
    const pass2 = await runExecutableBatch(timedOutForRetry, ctx, concurrency, itemTimeoutMs, {
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
  } else if (timedOutForRetry.length > 0) {
    for (const item of timedOutForRetry) {
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
    ctx.onExecItem?.(item.localPath, item.action, "start");
    ctx.ctx?.emit({ type: "exec_start", ts: Date.now(), pathLower: item.pathLower, action: actionType });
    const start = Date.now();
    try {
      await executeItem(item, ctx);
      ctx.onExecItem?.(item.localPath, item.action, "end", true);
      ctx.ctx?.emit({ type: "exec_end", ts: Date.now(), pathLower: item.pathLower, action: actionType, ok: true, duration: Date.now() - start });
      succeeded.push(item);
    } catch (e) {
      if (e instanceof ConflictSkippedError) {
        if (shouldDeferProtectedItem(item, ctx)) {
          ctx.onExecItem?.(item.localPath, item.action, "end", true);
          ctx.ctx?.emit({ type: "exec_end", ts: Date.now(), pathLower: item.pathLower, action: actionType, ok: true, duration: Date.now() - start });
          deferred.push(item);
        } else {
          logTemp(ctx.log, "P4", "manual conflict skip bound expired — applying keep_both", {
            path: item.localPath,
          }, { location: "executor.executePlan" });
          const conflictResult = await handleConflictKeepBoth(item, ctx);
          if (conflictResult.conflictSiblingPath) {
            item.conflictSiblingPath = conflictResult.conflictSiblingPath;
          }
          ctx.onExecItem?.(item.localPath, item.action, "end", true);
          ctx.ctx?.emit({ type: "exec_end", ts: Date.now(), pathLower: item.pathLower, action: actionType, ok: true, duration: Date.now() - start });
          succeeded.push(item);
        }
      } else {
        const errMsg = (e as Error).message;
        ctx.onExecItem?.(item.localPath, item.action, "end", false, errMsg);
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

    // Planned deletes are files only. Live listings may include nested folders and
    // the folder path itself — exclude those from set equality so a complete file
    // match still authorises recursive folder delete (empty nested dirs go with it).
    const folderLower = folder.toLowerCase().replace(/\/+$/, "");
    const liveFiles = live.filter(
      (entry) => !entry.isFolder && entry.pathLower !== folderLower,
    );
    const livePaths = new Set(liveFiles.map((f) => f.pathLower));
    const setsEqual =
      livePaths.size === planned.size
      && [...planned].every((pathLower) => livePaths.has(pathLower));

    if (!setsEqual) {
      const liveOnly = [...livePaths].filter((pathLower) => !planned.has(pathLower)).slice(0, 8);
      const plannedOnly = [...planned].filter((pathLower) => !livePaths.has(pathLower)).slice(0, 8);
      const liveFolders = live.filter((f) => f.isFolder).map((f) => f.pathLower).slice(0, 8);
      // Include liveOnly / liveFolders so logs show whether an extra file or nested
      // folder blocked coalesce (self-folder entries are already filtered above).
      // Runbook-dependent log — do not remove: runbook 03 Pass E asserts liveOnly / liveFolders fields.
      log?.("exec folder verify set mismatch — file deletes only", {
        folder,
        planned: planned.size,
        live: livePaths.size,
        liveFileCount: liveFiles.length,
        liveFolderCount: live.filter((f) => f.isFolder).length,
        liveOnly,
        plannedOnly,
        liveFolders,
        rawLiveCount: live.length,
      }, { hypothesisId: SyncHypotheses.deleteNotExecuted, location: "executor.verifyFolder" });
      remainingFileItems.push(...covered);
      continue;
    }

    const hashByPath = new Map(
      live.filter((f) => !f.isFolder).map((f) => [f.pathLower, f.contentHash]),
    );
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
 * Live-verify a single deleteRemote before mutating Dropbox (G24).
 * When remote content changed since planning, prefer download over delete (R5/R10).
 */
async function verifyIndividualDeleteRemote(
  item: SyncPlanItem,
  remote: RemoteStorage,
  store: SyncStateStore,
  log?: SyncMonitorLog,
): Promise<"proceed" | "reclassified-download"> {
  const base = await store.getEntry(item.pathLower);
  try {
    const live = await remote.download(item.localPath);
    const liveHash = live.metadata.hash ?? "";
    if (base?.baseRemoteHash && liveHash && liveHash !== base.baseRemoteHash) {
      logTemp(log, "P1", "deleteRemote live check — remote modified, reclassifying to download", {
        path: item.localPath,
        baseHash: shortHash(base.baseRemoteHash),
        liveHash: shortHash(liveHash),
      }, { location: "executor.verifyIndividualDeleteRemote" });
      item.action = {
        type: "download",
        reason: "remote_modified_local_deleted",
      };
      return "reclassified-download";
    }
  } catch (err) {
    if (!isDropboxPathNotFoundError(err)) {
      throw err;
    }
    logTemp(log, "P1", "deleteRemote live check — remote absent, proceeding", {
      path: item.localPath,
    }, { location: "executor.verifyIndividualDeleteRemote" });
  }
  return "proceed";
}

async function executeDownloadItem(
  item: SyncPlanItem,
  deps: ExecutorContext,
): Promise<void> {
  const { fs, remote, store } = deps;
  const { pathLower, localPath } = item;

  assertValidSyncPath(localPath, deps.strictLocalPaths ?? false);

  logIntent(deps, "download", { path: localPath });
  // G17: write to disk immediately; verify hash from disk so the buffer can GC.
  const { data, metadata } = await remote.download(localPath);
  const mtime = resolveWriteMtime(metadata);
  logTemp(deps.log, "P6", "download write-before-verify", {
    path: localPath,
    bytes: data.length,
    clientModified: metadata.clientModified ?? null,
    serverModified: metadata.serverModified,
  }, { location: "executor.executeDownloadItem" });
  await fs.write(localPath, data, mtime);
  const verifiedHash = await fs.computeHash(localPath);
  if (metadata.hash && verifiedHash !== metadata.hash) {
    throw new Error(
      `Hash mismatch after download: expected ${metadata.hash}, got ${verifiedHash}`,
    );
  }
  await updateSyncState(
    store,
    pathLower,
    localPath,
    verifiedHash,
    verifiedHash,
    metadata.rev,
    metadata.pathDisplay,
  );
  logOutcome(deps, "download", {
    path: localPath,
    bytes: data.length,
    verifiedHash: shortHash(verifiedHash),
    rev: metadata.rev,
    baseWritten: true,
  });
  emitPathNotice(deps, item, { remotePathDisplay: metadata.pathDisplay });
  if (deps.reloadOpenFile) {
    await deps.reloadOpenFile(localPath);
  }
}

function resolveWriteMtime(metadata: RemoteEntry): number | undefined {
  const mtime = metadata.clientModified ?? metadata.serverModified;
  return mtime > 0 ? mtime : undefined;
}

function emitPathNotice(
  deps: ExecutorContext,
  item: SyncPlanItem,
  context?: { remotePathDisplay?: string },
): void {
  const message = buildPathNotice(item, context);
  if (message) {
    deps.onPathNotice?.(message);
  }
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
    ctx.onExecItem?.(item.localPath, item.action, "start");
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
        ctx.onExecItem?.(item.localPath, item.action, "end", false, err.message);
        failed.push({ item, error: err });
        hooks.onItemSettled();
        return;
      }
      ctx.onExecItem?.(item.localPath, item.action, "end", true);
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
      ctx.onExecItem?.(item.localPath, item.action, "end", false, err.message);
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
      ctx.onExecItem?.(item.localPath, item.action, "start");
      try {
        await executeItem(item, ctx);
        ctx.onExecItem?.(item.localPath, item.action, "end", true);
        succeeded.push(item);
        hooks.onItemSettled();
      } catch (itemErr) {
        const err = itemErr instanceof Error ? itemErr : new Error(String(itemErr));
        ctx.onExecItem?.(item.localPath, item.action, "end", false, err.message);
        failed.push({ item, error: err });
        hooks.onItemSettled();
      }
    }
  };

  const coalesce = coalesceDeleteRemote({
    deleteRemoteItems,
    existingRemotePathLowers: ctx.existingRemotePathLowers ?? [],
    blockingPathLowers,
    log: ctx.log,
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
    ctx.onExecItem?.(item.localPath, item.action, "start");
    try {
      await executeItem(item, ctx);
      ctx.onExecItem?.(item.localPath, item.action, "end", true);
      succeeded.push(item);
      hooks.onItemSettled();
    } catch (itemErr) {
      const err = itemErr instanceof Error ? itemErr : new Error(String(itemErr));
      ctx.onExecItem?.(item.localPath, item.action, "end", false, err.message);
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
    ctx.onExecItem?.(item.localPath, item.action, "start");
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
      ctx.onExecItem?.(item.localPath, item.action, "end", true);
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
      ctx.onExecItem?.(item.localPath, item.action, "end", false, errMsg);
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

/**
 * Log the intent of a mutation before it is attempted. Paired with logOutcome
 * so a truncated log still shows what was in flight when things stopped.
 *
 * Runbook-dependent logs — do not remove: emits `"<action> intent"` / `"<action> done"`
 * strings that manual QA runbooks assert (deleteRemote/Local[/Folder], moveRemote,
 * createRemoteFolder, upload, … — see runbooks 01–04, 02, 08).
 */
function logIntent(
  deps: ExecutorContext,
  action: string,
  data: Record<string, unknown>,
): void {
  deps.log?.(`${action} intent`, data, {
    category: SyncLogCategories.transfer,
    level: "debug",
    location: `executor.${action}`,
  });
}

function logOutcome(
  deps: ExecutorContext,
  action: string,
  data: Record<string, unknown>,
): void {
  deps.log?.(`${action} done`, data, {
    category: SyncLogCategories.transfer,
    level: "debug",
    location: `executor.${action}`,
  });
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
      const { mtime: clientModified } = await fs.stat(localPath);

      const base = await store.getEntry(pathLower);
      const rev = base?.rev ?? undefined;

      // Whether a rev accompanies the upload is the difference between optimistic
      // locking and a blind overwrite (G29), so it is recorded on every upload.
      logIntent(deps, "upload", {
        path: localPath,
        bytes: data.length,
        localHash: shortHash(localHash),
        rev: rev ?? null,
        mode: rev ? "update(rev)" : "add",
        hasBase: !!base,
        clientModified,
      });

      let entry;
      try {
        entry = await remote.upload(localPath, data, rev, clientModified);
      } catch (err) {
        if (err instanceof RevConflictError) {
          logTemp(deps.log, "P2", "upload conflict — dispatching resolution", {
            path: localPath,
            hadRev: !!rev,
          }, { location: "executor.upload" });
          try {
            const conflictResult = await dispatchConflict(item, conflictCtx);
            if (conflictResult.conflictSiblingPath) {
              item.conflictSiblingPath = conflictResult.conflictSiblingPath;
            }
          } catch (conflictErr) {
            // Remote file was deleted — stale rev is useless; add-mode should succeed.
            if (conflictErr instanceof Error && conflictErr.message.includes("not_found")) {
              logTemp(deps.log, "P1", "rev conflict + remote deleted — add-mode retry", {
                path: localPath,
              }, { location: "executor.upload" });
              logIntent(deps, "upload", {
                path: localPath,
                bytes: data.length,
                mode: "add",
                reason: "rev_conflict_then_remote_deleted",
              });
              entry = await remote.upload(localPath, data, undefined, clientModified);
              await updateSyncState(store, pathLower, localPath, localHash, entry.hash ?? localHash, entry.rev);
              logOutcome(deps, "upload", { path: localPath, rev: entry.rev, baseWritten: true });
              emitPathNotice(deps, item);
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
      logOutcome(deps, "upload", {
        path: localPath,
        rev: entry.rev,
        remoteHash: shortHash(entry.hash),
        baseWritten: true,
      });
      emitPathNotice(deps, item);
      break;
    }

    case "download": {
      await executeDownloadItem(item, deps);
      break;
    }

    case "deleteLocal": {
      // Runbook-dependent logs — do not remove: runbooks 01 / 03 / 04 assert deleteLocal intent/done.
      logIntent(deps, "deleteLocal", { path: localPath });
      deps.onBeforeDeleteLocal?.(pathLower);
      await fs.delete(localPath);
      await store.deleteEntry(pathLower);
      logOutcome(deps, "deleteLocal", { path: localPath, baseRemoved: true });
      break;
    }

    case "deleteRemote": {
      // Runbook-dependent logs — do not remove: runbooks 01 / 03 assert deleteRemote intent/done.
      logIntent(deps, "deleteRemote", { path: localPath, coalesced: false });
      const verify = await verifyIndividualDeleteRemote(item, remote, store, deps.log);
      if (verify === "reclassified-download") {
        await executeDownloadItem(item, deps);
        break;
      }
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
      }
      await store.deleteEntry(pathLower);
      logOutcome(deps, "deleteRemote", { path: localPath, baseRemoved: true });
      break;
    }

    case "conflict": {
      const conflictResult = await dispatchConflict(item, conflictCtx);
      if (conflictResult.conflictSiblingPath) {
        item.conflictSiblingPath = conflictResult.conflictSiblingPath;
      }
      emitPathNotice(deps, item);
      if (deps.reloadOpenFile) {
        await deps.reloadOpenFile(localPath);
      }
      break;
    }

    case "preserveAsConflictCopy": {
      // R10: remote deletion stands at the canonical path; local bytes move to a
      // Dropbox-format conflict sibling and upload there — never resurrect the original name.
      assertValidSyncPath(localPath, deps.strictLocalPaths ?? false);
      const data = await fs.read(localPath);
      const localHash = await dropboxContentHashBrowser(data);
      const { mtime: clientModified } = await fs.stat(localPath);
      const conflictPath = await resolveConflictCopyPath(fs, localPath, deps.log);
      const conflictPathLower = conflictPath.toLowerCase();

      // Runbook-dependent log — do not remove: runbook 04 Pass D asserts preserveAsConflictCopy / R10 wording.
      logRule(deps.log, SyncRules.R10, "preserving local bytes as conflict copy — path stays deleted", {
        path: localPath,
        conflictCopyPath: conflictPath,
        localHash: shortHash(localHash),
      }, { level: "info", location: "executor.preserveAsConflictCopy" });

      await fs.rename(localPath, conflictPath);
      logIntent(deps, "upload", {
        path: conflictPath,
        bytes: data.length,
        localHash: shortHash(localHash),
        mode: "add",
        reason: action.reason,
      });
      const entry = await remote.upload(conflictPath, data, undefined, clientModified);
      await updateSyncState(
        store,
        conflictPathLower,
        conflictPath,
        localHash,
        entry.hash ?? localHash,
        entry.rev,
        entry.pathDisplay,
      );
      item.conflictSiblingPath = conflictPath;
      // Runbook-dependent log — do not remove: runbook 04 Pass D asserts canonical path not restored.
      logTemp(deps.log, "P2", "R10 conflict copy uploaded; canonical path not restored", {
        originalPath: localPath,
        conflictCopyPath: conflictPath,
        rev: entry.rev,
      }, { location: "executor.preserveAsConflictCopy" });
      logOutcome(deps, "upload", {
        path: conflictPath,
        rev: entry.rev,
        baseWritten: true,
      });
      emitPathNotice(deps, item);
      break;
    }

    case "recordBase": {
      await updateSyncState(
        store,
        pathLower,
        localPath,
        action.localHash,
        action.remoteHash,
        action.rev,
        action.pathDisplay,
      );
      logTemp(deps.log, "P3", "recordBase — refreshed sync base without transfer", {
        path: localPath,
        hash: shortHash(action.localHash),
        pathDisplay: action.pathDisplay,
      }, { location: "executor.recordBase" });
      logOutcome(deps, "recordBase", {
        path: localPath,
        baseWritten: true,
      });
      emitPathNotice(deps, item, { remotePathDisplay: action.pathDisplay });
      break;
    }

    case "moveLocal": {
      logIntent(deps, "moveLocal", {
        from: action.fromPath,
        to: action.toPath,
        reason: action.reason,
      });
      await fs.rename(action.fromPath, action.toPath);
      await relocateSyncEntry(store, action.fromPath, action.toPath, { pathDisplay: action.toPath });
      logTemp(deps.log, "P5", "moveLocal completed", {
        from: action.fromPath,
        to: action.toPath,
        reason: action.reason,
      }, { location: "executor.moveLocal" });
      logOutcome(deps, "moveLocal", { from: action.fromPath, to: action.toPath });
      emitPathNotice(deps, item, { remotePathDisplay: action.toPath });
      break;
    }

    case "moveRemote": {
      // Runbook-dependent logs — do not remove: runbook 02 asserts moveRemote intent/done (+ rename/move chips).
      logIntent(deps, "moveRemote", {
        from: action.fromPath,
        to: action.toPath,
        reason: action.reason,
      });
      const moved = await moveRemotePath(remote, action.fromPath, action.toPath);
      await relocateSyncEntry(store, action.fromPath, action.toPath, {
        pathDisplay: moved.pathDisplay,
        remoteHash: moved.hash ?? undefined,
        rev: moved.rev,
      });
      logTemp(deps.log, "P5", "moveRemote completed", {
        from: action.fromPath,
        to: action.toPath,
        reason: action.reason,
        pathDisplay: moved.pathDisplay,
      }, { location: "executor.moveRemote" });
      logOutcome(deps, "moveRemote", { from: action.fromPath, to: action.toPath, rev: moved.rev });
      emitPathNotice(deps, item, { remotePathDisplay: moved.pathDisplay });
      break;
    }

    case "createLocalFolder": {
      // Sync-root row ("", "/") is the vault itself — mkdir would be meaningless / harmful.
      if (localPath.trim() === "" || localPath.trim() === "/") {
        logTemp(deps.log, "P5", "createLocalFolder skipped — sync root", { path: localPath }, { location: "executor.createLocalFolder" });
        break;
      }
      logIntent(deps, "createLocalFolder", { path: localPath });
      await fs.createFolder(localPath);
      await updateFolderSyncState(store, pathLower, localPath);
      logTemp(deps.log, "P5", "createLocalFolder completed", { path: localPath }, { location: "executor.createLocalFolder" });
      logOutcome(deps, "createLocalFolder", { path: localPath });
      break;
    }

    case "createRemoteFolder": {
      // Dropbox create_folder("/") under a sync prefix becomes "//" and is rejected.
      if (localPath.trim() === "" || localPath.trim() === "/") {
        logTemp(deps.log, "P5", "createRemoteFolder skipped — sync root", { path: localPath }, { location: "executor.createRemoteFolder" });
        break;
      }
      // Runbook-dependent logs — do not remove: runbook 02 Pass F/G accept createRemoteFolder fallback.
      logIntent(deps, "createRemoteFolder", { path: localPath });
      const created = await remote.createFolder(localPath);
      await updateFolderSyncState(store, pathLower, localPath, created.pathDisplay);
      logTemp(deps.log, "P5", "createRemoteFolder completed", { path: localPath }, { location: "executor.createRemoteFolder" });
      logOutcome(deps, "createRemoteFolder", { path: localPath });
      break;
    }

    case "deleteLocalFolder": {
      // Runbook-dependent logs — do not remove: runbook 03 Pass D asserts deleteLocalFolder same cycle.
      logIntent(deps, "deleteLocalFolder", { path: localPath });
      await fs.deleteFolder(localPath);
      await store.deleteEntry(pathLower);
      logOutcome(deps, "deleteLocalFolder", { path: localPath });
      break;
    }

    case "deleteRemoteFolder": {
      // Runbook-dependent logs — do not remove: runbooks 01–03 assert deleteRemoteFolder / tree wipe.
      logIntent(deps, "deleteRemoteFolder", { path: localPath });
      try {
        await remote.delete(localPath);
      } catch (err) {
        // Same policy as deleteRemote: already-absent remote is success (e.g. parent
        // folder wipe or a prior sync already removed this empty folder).
        if (!isDropboxPathNotFoundError(err)) {
          throw err;
        }
        deps.log?.("deleteRemoteFolder already absent — treating as success", {
          path: localPath,
          error: err instanceof Error ? err.message : String(err),
        }, { hypothesisId: SyncHypotheses.deleteNotExecuted, location: "executor.deleteRemoteFolder" });
      }
      await store.deleteEntry(pathLower);
      logOutcome(deps, "deleteRemoteFolder", { path: localPath });
      break;
    }

    case "moveLocalFolder": {
      await fs.rename(action.fromPath, action.toPath);
      await relocateFolderSyncEntry(store, action.fromPath, action.toPath);
      logTemp(deps.log, "P5", "moveLocalFolder completed", {
        from: action.fromPath,
        to: action.toPath,
      }, { location: "executor.moveLocalFolder" });
      break;
    }

    case "moveRemoteFolder": {
      // Runbook-dependent log — do not remove: runbook 02 Pass C/D/E prefer moveRemoteFolder.
      const moved = await moveRemotePath(remote, action.fromPath, action.toPath);
      await relocateFolderSyncEntry(store, action.fromPath, action.toPath, moved.pathDisplay);
      logTemp(deps.log, "P5", "moveRemoteFolder completed", {
        from: action.fromPath,
        to: action.toPath,
      }, { location: "executor.moveRemoteFolder" });
      break;
    }

    case "pathCollision":
      logTemp(deps.log, "P5", "pathCollision skipped at execute", {
        path: localPath,
        reason: action.reason,
      }, { location: "executor.pathCollision" });
      break;

    case "noop":
      break;
  }
}

async function relocateSyncEntry(
  store: SyncStateStore,
  fromPath: string,
  toPath: string,
  remote?: { pathDisplay?: string; remoteHash?: string; rev?: string },
): Promise<void> {
  const fromLower = fromPath.toLowerCase();
  const toLower = toPath.toLowerCase();
  const existing = await store.getEntry(fromLower) ?? await store.getEntry(toLower);
  const entry = {
    pathLower: toLower,
    localPath: toPath,
    basePathDisplay: remote?.pathDisplay ?? toPath,
    baseLocalHash: existing?.baseLocalHash ?? null,
    baseRemoteHash: remote?.remoteHash ?? existing?.baseRemoteHash ?? null,
    rev: remote?.rev ?? existing?.rev ?? null,
    lastSynced: Date.now(),
    entryKind: existing?.entryKind,
  };
  await store.setEntry(entry);
  if (fromLower !== toLower) {
    await store.deleteEntry(fromLower);
  }
}

async function updateFolderSyncState(
  store: SyncStateStore,
  pathLower: string,
  localPath: string,
  pathDisplay?: string,
): Promise<void> {
  await store.setEntry({
    pathLower,
    localPath,
    basePathDisplay: pathDisplay ?? localPath,
    baseLocalHash: null,
    baseRemoteHash: null,
    rev: null,
    lastSynced: Date.now(),
    entryKind: "folder",
  });
}

async function relocateFolderSyncEntry(
  store: SyncStateStore,
  fromPath: string,
  toPath: string,
  pathDisplay?: string,
): Promise<void> {
  const fromLower = fromPath.toLowerCase();
  const toLower = toPath.toLowerCase();
  // Folder server-move relocates the whole tree on Dropbox — rewrite every base
  // entry under the old prefix so the next cycle does not see ghost deletes.
  const entries = await store.getAllEntries();
  const toRewrite = entries.filter(
    (entry) =>
      entry.pathLower === fromLower || entry.pathLower.startsWith(`${fromLower}/`),
  );
  // Deepest paths first so we never briefly collide path_lower keys while rewriting.
  toRewrite.sort((a, b) => b.pathLower.length - a.pathLower.length);

  for (const entry of toRewrite) {
    const newLower =
      entry.pathLower === fromLower
        ? toLower
        : `${toLower}${entry.pathLower.slice(fromLower.length)}`;
    // Preserve child-segment casing from the existing localPath / display.
    const newLocalPath =
      entry.pathLower === fromLower
        ? toPath
        : `${toPath}${entry.localPath.slice(fromLower.length)}`;
    const priorDisplay = entry.basePathDisplay ?? entry.localPath;
    const newDisplay =
      entry.pathLower === fromLower
        ? (pathDisplay ?? toPath)
        : `${pathDisplay ?? toPath}${priorDisplay.slice(fromLower.length)}`;
    await store.setEntry({
      ...entry,
      pathLower: newLower,
      localPath: newLocalPath,
      basePathDisplay: newDisplay,
      lastSynced: Date.now(),
    });
    if (entry.pathLower !== newLower) {
      await store.deleteEntry(entry.pathLower);
    }
  }

  if (toRewrite.length === 0) {
    await updateFolderSyncState(store, toLower, toPath, pathDisplay ?? toPath);
  }
}

// Re-export for backward compatibility (tests, engine 등에서 import)
export {
  makeConflictPath,
  findNewestConflictSibling,
  isConflictFile,
  conflictPathToCanonicalPath,
} from "./conflict-handlers";
