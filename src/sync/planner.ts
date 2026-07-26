import type { FileInfo, RemoteEntry, SyncEntry, SyncAction, SyncPlanItem, SyncPlan } from "../types";
import { emptySyncPlanStats } from "../types";
import type { CycleContext } from "./cycle-context";
import {
  logDecision,
  logRule,
  shortHash,
  type SyncMonitorLog,
} from "../debug/sync-monitor";
import { SyncRules } from "../debug/sync-monitor";

/** 로컬 파일 상태 (planner 입력) */
export interface LocalState {
  hash: string;
  path: string;
}

/** 원격 파일 상태 (planner 입력) */
export interface RemoteState {
  hash: string;
  pathDisplay: string;
  rev: string;
  deleted: boolean;
}

export interface ClassifyOptions {
  /** 로컬에서 삭제 이벤트가 기록되었는지 */
  localDeleteIntended?: boolean;
  /** Structured rule/decision logging. Absent in pure unit tests. */
  log?: SyncMonitorLog;
  /** pathLower for log correlation when logging is enabled. */
  pathLower?: string;
}

/**
 * 단일 파일의 동기화 액션을 결정하는 순수 함수.
 *
 * 판단 기준: content_hash와 base(마지막 동기화 시점) 비교
 * - local/remote가 null이면 해당 측에 파일 없음
 * - base가 null이면 이전 동기화 기록 없음
 * - localDeleteIntended: true일 때만 부재→deleteRemote. 미지정이면 부재→download(안전)
 */
export function classifyChange(
  local: LocalState | null,
  remote: RemoteState | null,
  base: SyncEntry | null,
  options?: ClassifyOptions,
): SyncAction {
  const localExists = local !== null;
  const remoteExists = remote !== null && !remote.deleted;

  if (localExists && remoteExists) return classifyBothExist(local, remote, base, options);
  if (localExists && !remoteExists) return classifyLocalOnly(local, base, options);
  if (!localExists && remoteExists) return classifyRemoteOnly(remote, base, options);
  return { type: "noop", reason: "both_absent" };
}

/** 양쪽 모두 존재: hash 비교 → base 기반 변경 감지 */
function classifyBothExist(
  local: LocalState,
  remote: RemoteState,
  base: SyncEntry | null,
  options?: ClassifyOptions,
): SyncAction {
  const path = options?.pathLower ?? local.path;

  if (local.hash === remote.hash) {
    // R8: identical bytes are not a disagreement, whatever the dates say.
    logRule(options?.log, SyncRules.R8, "hashes match — not a change", {
      path,
      hash: shortHash(local.hash),
    }, { level: "trace", location: "planner.classifyBothExist" });
    return { type: "noop", reason: "same_content" };
  }

  if (!base) {
    logRule(options?.log, [SyncRules.R1, SyncRules.R2], "conflict: differing content, no base", {
      path,
      localHash: shortHash(local.hash),
      remoteHash: shortHash(remote.hash),
    }, { location: "planner.classifyBothExist" });
    return { type: "conflict", localHash: local.hash, remoteHash: remote.hash };
  }

  const localChanged = local.hash !== base.baseLocalHash;
  const remoteChanged = remote.hash !== base.baseRemoteHash;

  if (localChanged && remoteChanged) {
    logRule(options?.log, [SyncRules.R1, SyncRules.R2], "conflict: both sides changed since base", {
      path,
      localHash: shortHash(local.hash),
      remoteHash: shortHash(remote.hash),
      baseLocalHash: shortHash(base.baseLocalHash),
      baseRemoteHash: shortHash(base.baseRemoteHash),
    }, { location: "planner.classifyBothExist" });
    return { type: "conflict", localHash: local.hash, remoteHash: remote.hash };
  }
  if (localChanged) {
    return { type: "upload", reason: "local_modified" };
  }
  if (remoteChanged) {
    return { type: "download", reason: "remote_modified" };
  }
  // 양쪽 base 대비 미변경이지만 hash가 다름 (base hash 불일치 — 복구 상황)
  logRule(options?.log, [SyncRules.R1, SyncRules.R2], "conflict: base hashes disagree with both sides", {
    path,
    localHash: shortHash(local.hash),
    remoteHash: shortHash(remote.hash),
    baseLocalHash: shortHash(base.baseLocalHash),
    baseRemoteHash: shortHash(base.baseRemoteHash),
  }, { location: "planner.classifyBothExist" });
  return { type: "conflict", localHash: local.hash, remoteHash: remote.hash };
}

/** 로컬만 존재: base 유무로 새 파일 vs 원격 삭제 판단 */
function classifyLocalOnly(
  local: LocalState,
  base: SyncEntry | null,
  options?: ClassifyOptions,
): SyncAction {
  const path = options?.pathLower ?? local.path;

  if (base) {
    // base 대비 변경됨 → 삭제+수정 교차 → upload (변경 우선)
    if (local.hash !== base.baseLocalHash) {
      // R5: an edit beats a delete — the file is resurrected.
      logRule(options?.log, SyncRules.R5, "edit beats remote delete — resurrecting", {
        path,
        localHash: shortHash(local.hash),
        baseLocalHash: shortHash(base.baseLocalHash),
      }, { level: "info", location: "planner.classifyLocalOnly" });
      return { type: "upload", reason: "local_modified_remote_deleted" };
    }
    // base 대비 미변경 → 원격에서 삭제됨
    return { type: "deleteLocal", reason: "deleted_on_remote" };
  }
  // R6 / R10: no base and no remote — cannot tell "never existed" from "deleted
  // while we were offline". Today we silently upload (G3); Phase 3 will ask or
  // preserve as a conflict copy when revision evidence exists.
  logRule(options?.log, [SyncRules.R6, SyncRules.R10], "new_local with no durable delete check", {
    path,
    checkedRevisions: false,
  }, { level: "debug", location: "planner.classifyLocalOnly" });
  return { type: "upload", reason: "new_local" };
}

/** 원격만 존재: base 유무 + 삭제 의도로 다운로드 vs 삭제 판단 */
function classifyRemoteOnly(
  remote: RemoteState,
  base: SyncEntry | null,
  options?: ClassifyOptions,
): SyncAction {
  const path = options?.pathLower ?? remote.pathDisplay;

  if (base) {
    // base 대비 변경됨 → 삭제+수정 교차 → download (변경 우선)
    if (remote.hash !== base.baseRemoteHash) {
      // R5: the remote edit beats this device's delete.
      logRule(options?.log, SyncRules.R5, "remote edit beats local delete — restoring", {
        path,
        remoteHash: shortHash(remote.hash),
        baseRemoteHash: shortHash(base.baseRemoteHash),
      }, { level: "info", location: "planner.classifyRemoteOnly" });
      return { type: "download", reason: "remote_modified_local_deleted" };
    }
    // base 대비 미변경 → 삭제 의도 확인
    if (options?.localDeleteIntended) {
      return { type: "deleteRemote", reason: "deleted_on_local" };
    }
    // R6: absence alone is never evidence of a delete — restore rather than remove.
    logRule(options?.log, SyncRules.R6, "missing locally with no delete intent — restoring, not deleting", {
      path,
    }, { location: "planner.classifyRemoteOnly" });
    return { type: "download", reason: "missing_local_restored" };
  }
  return { type: "download", reason: "new_remote" };
}

export interface PlanOptions {
  /** 로컬에서 의도적으로 삭제된 경로 (pathLower) */
  localDeletedPaths?: Set<string>;
  /** 사이클 컨텍스트 (decision trace) */
  ctx?: CycleContext;
  /** 플랜 결정 시마다 호출 (라이브 리포트용) */
  onPlanItem?: (pathLower: string, localPath: string, actionType: string, reason: string) => void;
  /** Structured rule/decision logging. */
  log?: SyncMonitorLog;
}

/**
 * 전체 동기화 계획을 생성하는 순수 함수.
 *
 * 로컬 파일 목록, 원격 변경 목록, 이전 상태를 받아
 * 각 파일에 대한 동기화 액션을 결정한다.
 */
export function createPlan(
  localFiles: FileInfo[],
  remoteEntries: RemoteEntry[],
  baseEntries: SyncEntry[],
  options?: PlanOptions,
): SyncPlan {
  // pathLower 기준으로 맵 구성
  const localMap = new Map<string, FileInfo>();
  for (const f of localFiles) {
    localMap.set(f.pathLower, f);
  }

  const remoteMap = new Map<string, RemoteEntry>();
  for (const e of remoteEntries) {
    // G8: folders are planned in plan-enhancements only. File classify coerces
    // hash:null → "" which looked like remote_modified_local_deleted vs folder base.
    if (e.isFolder) continue;
    remoteMap.set(e.pathLower, e);
  }

  const baseMap = new Map<string, SyncEntry>();
  for (const e of baseEntries) {
    if (e.entryKind === "folder") continue;
    baseMap.set(e.pathLower, e);
  }

  // 모든 pathLower 수집
  const allPaths = new Set<string>();
  for (const k of localMap.keys()) allPaths.add(k);
  for (const k of remoteMap.keys()) allPaths.add(k);
  for (const k of baseMap.keys()) allPaths.add(k);

  const items: SyncPlanItem[] = [];
  const stats = emptySyncPlanStats();

  for (const pathLower of allPaths) {
    const localFile = localMap.get(pathLower) ?? null;
    const remoteEntry = remoteMap.get(pathLower) ?? null;
    const baseEntry = baseMap.get(pathLower) ?? null;

    const localState: LocalState | null = localFile
      ? { hash: localFile.hash, path: localFile.path }
      : null;

    const remoteState: RemoteState | null = remoteEntry
      ? {
          hash: remoteEntry.hash ?? "",
          pathDisplay: remoteEntry.pathDisplay,
          rev: remoteEntry.rev,
          deleted: remoteEntry.deleted,
        }
      : null;

    const localDeleteIntended = options?.localDeletedPaths?.has(pathLower);
    const classifyOpts: ClassifyOptions = {
      localDeleteIntended,
      log: options?.log,
      pathLower,
    };
    const action = classifyChange(localState, remoteState, baseEntry, classifyOpts);

    if (options?.ctx) {
      options.ctx.emit({
        type: "plan_decision",
        ts: Date.now(),
        pathLower,
        action: action.type,
        reason: "reason" in action ? action.reason : `conflict(${action.localHash?.slice(0, 8)}/${action.remoteHash?.slice(0, 8)})`,
        localHash: localState?.hash ?? null,
        remoteHash: remoteState?.hash ?? null,
        baseLocalHash: baseEntry?.baseLocalHash ?? null,
        baseRemoteHash: baseEntry?.baseRemoteHash ?? null,
      });
    }

    const localPath =
      localFile?.path ?? remoteEntry?.pathDisplay ?? baseEntry?.localPath ?? pathLower;

    const reasonStr =
      action.type === "noop"
        ? "noop"
        : "reason" in action
          ? String(action.reason)
          : action.type;
    options?.onPlanItem?.(pathLower, localPath, action.type, reasonStr);

    // Every path is logged, including noop. "Nothing happened here" is the
    // outcome G4 showed we could not previously see, and it is the first thing
    // needed when a user reports a file that will not sync.
    logDecision(
      options?.log,
      {
        pathLower,
        localPath,
        localHash: shortHash(localState?.hash ?? null),
        remoteHash: shortHash(remoteState?.hash ?? null),
        baseLocalHash: shortHash(baseEntry?.baseLocalHash ?? null),
        baseRemoteHash: shortHash(baseEntry?.baseRemoteHash ?? null),
        rev: remoteState?.rev ?? baseEntry?.rev ?? null,
        localDeleteIntended: !!localDeleteIntended,
      },
      action.type,
      action.type === "conflict"
        ? `conflict(${shortHash(action.localHash)}/${shortHash(action.remoteHash)})`
        : reasonStr,
    );

    if (action.type === "noop") {
      stats.noop++;
      // G4: same_content must still write base so a later absence is not treated as new_local.
      if (action.reason === "same_content" && localState && remoteState) {
        items.push({
          pathLower,
          localPath,
          action: {
            type: "recordBase",
            reason: "same_content",
            localHash: localState.hash,
            remoteHash: remoteState.hash,
            rev: remoteState.rev,
            pathDisplay: remoteState.pathDisplay,
          },
        });
        stats.recordBase++;
      }
      continue;
    }

    items.push({ pathLower, localPath, action });
    stats[action.type]++;
  }

  return { items, stats };
}
