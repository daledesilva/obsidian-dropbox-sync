import type { DeleteGuardResult, SyncPlan, SyncPlanItem } from "../types";

/** True for deleteLocal / deleteRemote plan actions. */
export function isDeletePlanAction(type: string): boolean {
  return type === "deleteRemote" || type === "deleteLocal";
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
      stats: { ...plan.stats, deleteLocal: 0, deleteRemote: 0 },
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
): DeleteGuardResult {
  if (!enabled) {
    return { passed: true, deleteItems: [], filteredPlan: plan };
  }

  const { deleteItems, nonDeletePlan } = splitPlanDeletes(plan);

  if (deleteItems.length <= threshold) {
    return { passed: true, deleteItems: [], filteredPlan: plan };
  }

  return {
    passed: false,
    deleteItems,
    filteredPlan: nonDeletePlan,
  };
}
