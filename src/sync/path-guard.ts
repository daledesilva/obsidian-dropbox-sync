import type { PathGuardIssue, PathGuardResult, SyncPlan, SyncPlanItem } from "../types";
import { getPathIssues, suggestFixedPath } from "./path-validator";

const PATH_CHECK_ACTIONS = new Set([
  "upload",
  "download",
  "deleteLocal",
  "deleteRemote",
  "conflict",
]);

function needsPathCheck(item: SyncPlanItem): boolean {
  return PATH_CHECK_ACTIONS.has(item.action.type);
}

/**
 * 플랜에서 경로 호환성 문제가 있는 항목을 분리한다.
 */
export function checkPathGuard(plan: SyncPlan, strictLocal: boolean): PathGuardResult {
  const issues: PathGuardIssue[] = [];
  const blockedPathLowers = new Set<string>();

  for (const item of plan.items) {
    if (!needsPathCheck(item)) continue;

    const pathIssues = getPathIssues(item.localPath, strictLocal);
    if (pathIssues.length === 0) continue;

    blockedPathLowers.add(item.pathLower);
    issues.push({
      item,
      issues: pathIssues,
      suggestedPath: suggestFixedPath(item.localPath),
    });
  }

  if (issues.length === 0) {
    return { passed: true, issues: [], filteredPlan: plan };
  }

  const filteredItems = plan.items.filter((i) => !blockedPathLowers.has(i.pathLower));
  const filteredPlan: SyncPlan = {
    items: filteredItems,
    stats: countStats(filteredItems),
  };

  return { passed: false, issues, filteredPlan };
}

function countStats(items: SyncPlanItem[]): SyncPlan["stats"] {
  const stats = {
    upload: 0,
    download: 0,
    deleteLocal: 0,
    deleteRemote: 0,
    conflict: 0,
    noop: 0,
  };
  for (const item of items) {
    const t = item.action.type;
    if (t in stats) stats[t as keyof typeof stats]++;
  }
  return stats;
}
