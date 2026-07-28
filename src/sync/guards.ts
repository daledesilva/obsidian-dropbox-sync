import type { DeleteGuardResult, SyncPlan, SyncPlanItem } from "../types";
import { logRule, SyncRules, type SyncMonitorLog } from "../debug/sync-monitor";

/**
 * True for any destructive delete plan action.
 * Folder deletes must be included: deferDeletes / R9 previously only peeled file
 * deletes, so deleteRemoteFolder ran before the confirmation modal and wiped Dropbox.
 */
export function isDeletePlanAction(type: string): boolean {
  return (
    type === "deleteRemote"
    || type === "deleteLocal"
    || type === "deleteRemoteFolder"
    || type === "deleteLocalFolder"
  );
}

/**
 * R9 threshold weight: a folder wipe removes an unbounded tree, so one folder
 * delete alone must never auto-approve under a file-count threshold.
 */
export function deleteGuardEffectiveCount(
  deleteItems: SyncPlanItem[],
  threshold: number,
): number {
  let count = 0;
  for (const item of deleteItems) {
    const actionType = item.action.type;
    if (actionType === "deleteRemoteFolder" || actionType === "deleteLocalFolder") {
      count += threshold + 1;
    } else {
      count += 1;
    }
  }
  return count;
}

/**
 * Always split deletes from the rest of a plan (threshold-agnostic).
 * Manual multi-section sync uses this to defer all deletions until a trailing
 * Deletions progress segment, then confirm over-threshold sections there.
 */
export function splitPlanDeletes(plan: SyncPlan): {
  deleteItems: SyncPlanItem[];
  nonDeletePlan: SyncPlan;
} {
  const deleteItems = plan.items.filter((item) => isDeletePlanAction(item.action.type));
  if (deleteItems.length === 0) {
    return { deleteItems: [], nonDeletePlan: plan };
  }
  const nonDeleteItems = plan.items.filter((item) => !isDeletePlanAction(item.action.type));
  return {
    deleteItems,
    nonDeletePlan: {
      items: nonDeleteItems,
      stats: {
        ...plan.stats,
        deleteLocal: 0,
        deleteRemote: 0,
        deleteLocalFolder: 0,
        deleteRemoteFolder: 0,
      },
    },
  };
}

/**
 * 대량 삭제 가드. 삭제 개수가 임계값을 초과하면 차단.
 *
 * - passed: true → 원본 plan 그대로 실행
 * - passed: false → filteredPlan(삭제 제외)만 실행하고 deleteItems를 사용자에게 확인
 */
export function checkDeleteGuard(
  plan: SyncPlan,
  threshold: number,
  enabled = true,
  log?: SyncMonitorLog,
): DeleteGuardResult {
  if (!enabled) {
    // R9 logs even when disabled — "the guard never ran" and "the guard passed"
    // look identical in a log that only records the blocking case.
    logRule(log, SyncRules.R9, "delete guard disabled — not asking", {
      deleteCount: plan.items.filter((item) => isDeletePlanAction(item.action.type)).length,
    }, { location: "guards.checkDeleteGuard" });
    return { passed: true, deleteItems: [], filteredPlan: plan };
  }

  const { deleteItems, nonDeletePlan } = splitPlanDeletes(plan);
  const effectiveCount = deleteGuardEffectiveCount(deleteItems, threshold);

  if (effectiveCount <= threshold) {
    logRule(log, SyncRules.R9, "delete guard passed — under threshold", {
      deleteCount: deleteItems.length,
      effectiveCount,
      threshold,
    }, { location: "guards.checkDeleteGuard" });
    return { passed: true, deleteItems: [], filteredPlan: plan };
  }

  logRule(log, SyncRules.R9, "delete guard triggered — asking before removing", {
    deleteCount: deleteItems.length,
    effectiveCount,
    threshold,
  }, { level: "info", location: "guards.checkDeleteGuard" });
  return {
    passed: false,
    deleteItems,
    filteredPlan: nonDeletePlan,
  };
}
