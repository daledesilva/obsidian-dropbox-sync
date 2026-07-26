import type { SyncAction, SyncPlanItem } from "../types";
import { classifyPermanentFailure } from "./permanent-skip";

/** Meta key for durable failed-path retry queue (G27). */
export const RETRY_SET_META_KEY = "retrySet";

/** One path/action pair to retry after the cursor checkpoints past a failure. */
export interface RetrySetEntry {
  pathLower: string;
  localPath: string;
  action: SyncAction;
  errorMessage?: string;
  addedAt: number;
}

export function parseRetrySet(raw: string | null): RetrySetEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRetrySetEntry);
  } catch {
    return [];
  }
}

function isRetrySetEntry(value: unknown): value is RetrySetEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as RetrySetEntry;
  return (
    typeof entry.pathLower === "string"
    && typeof entry.localPath === "string"
    && entry.action !== null
    && typeof entry.action === "object"
    && typeof entry.addedAt === "number"
  );
}

export function serializeRetrySet(entries: RetrySetEntry[]): string {
  return JSON.stringify(entries);
}

/** Merge retry-set items missing from the planner output so failed paths still run. */
export function mergeRetryItemsIntoPlan(
  planItems: SyncPlanItem[],
  retryEntries: RetrySetEntry[],
): SyncPlanItem[] {
  if (retryEntries.length === 0) return planItems;
  const plannedPathLowers = new Set(planItems.map((item) => item.pathLower));
  const extras: SyncPlanItem[] = [];
  for (const entry of retryEntries) {
    if (plannedPathLowers.has(entry.pathLower)) continue;
    extras.push({
      pathLower: entry.pathLower,
      localPath: entry.localPath,
      action: entry.action,
    });
  }
  if (extras.length === 0) return planItems;
  return [...planItems, ...extras];
}

export function buildRetrySetAfterCycle(
  previous: RetrySetEntry[],
  result: { succeeded: SyncPlanItem[]; failed: { item: SyncPlanItem; error: Error }[] },
  now = Date.now(),
): RetrySetEntry[] {
  const byPath = new Map<string, RetrySetEntry>();
  for (const entry of previous) {
    byPath.set(entry.pathLower, entry);
  }
  for (const item of result.succeeded) {
    byPath.delete(item.pathLower);
  }
  for (const failure of result.failed) {
    // G17: permanent local/transport failures live in permanentSkipSet, not retrySet.
    if (classifyPermanentFailure(failure.error)) continue;
    byPath.set(failure.item.pathLower, {
      pathLower: failure.item.pathLower,
      localPath: failure.item.localPath,
      action: failure.item.action,
      errorMessage: failure.error.message,
      addedAt: byPath.get(failure.item.pathLower)?.addedAt ?? now,
    });
  }
  return [...byPath.values()];
}
