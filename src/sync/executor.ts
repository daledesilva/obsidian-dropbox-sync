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
  /** 사이클 컨텍스트 (execution trace) */
  ctx?: CycleContext;
  /** iOS/모바일 등 로컬 경로 규칙 적용 */
  strictLocalPaths?: boolean;
}

/** 내부 함수에서 사용하는 통합 컨텍스트 */
type ExecutorContext = ExecutorDeps & ExecutorConfig;

/**
 * SyncPlan의 각 항목을 실행한다.
 *
 * - 항목별로 독립 실행 (하나 실패해도 나머지 계속)
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
  let completed = 0;
  const total = executable.length + conflicts.length;

  // 일반 항목: 병렬
  const tasks = executable.map((item) => async () => {
    ctx.ctx?.emit({ type: "exec_start", ts: Date.now(), pathLower: item.pathLower, action: item.action.type });
    const start = Date.now();
    try {
      await executeItem(item, ctx);
      ctx.ctx?.emit({ type: "exec_end", ts: Date.now(), pathLower: item.pathLower, action: item.action.type, ok: true, duration: Date.now() - start });
    } catch (e) {
      ctx.ctx?.emit({ type: "exec_end", ts: Date.now(), pathLower: item.pathLower, action: item.action.type, ok: false, error: (e as Error).message, duration: Date.now() - start });
      throw e;
    }
  });
  const settled = await runWithConcurrency(tasks, concurrency, {
    signal: ctx.signal,
    onTaskComplete: () => {
      completed++;
      ctx.onProgress?.(completed, total);
    },
  });

  const succeeded: SyncPlanItem[] = [];
  const failed: { item: SyncPlanItem; error: Error }[] = [];

  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (!r) continue; // signal로 건너뛴 항목
    if (r.status === "fulfilled") {
      succeeded.push(executable[i]);
    } else {
      failed.push({ item: executable[i], error: r.reason as Error });
    }
  }

  // conflict 항목: 직렬 (모달이 순차적으로 뜨도록)
  if (conflicts.length > 0) {
    ctx.onConflictCount?.(conflicts.length);
  }
  for (const item of conflicts) {
    if (ctx.signal?.aborted) break;
    ctx.ctx?.emit({ type: "exec_start", ts: Date.now(), pathLower: item.pathLower, action: item.action.type });
    const start = Date.now();
    try {
      await executeItem(item, ctx);
      ctx.ctx?.emit({ type: "exec_end", ts: Date.now(), pathLower: item.pathLower, action: item.action.type, ok: true, duration: Date.now() - start });
      succeeded.push(item);
    } catch (e) {
      if (e instanceof ConflictSkippedError) {
        ctx.ctx?.emit({ type: "exec_end", ts: Date.now(), pathLower: item.pathLower, action: item.action.type, ok: true, duration: Date.now() - start });
        deferred.push(item);
      } else {
        ctx.ctx?.emit({ type: "exec_end", ts: Date.now(), pathLower: item.pathLower, action: item.action.type, ok: false, error: (e as Error).message, duration: Date.now() - start });
        failed.push({ item, error: e as Error });
      }
    }
    completed++;
    ctx.onProgress?.(completed, total);
  }

  return { succeeded, failed, deferred };
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
