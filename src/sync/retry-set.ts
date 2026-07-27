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

/** Merge retry-set items into the planner output so failed paths still run (G27).
 *
 * After a cursor checkpoint, base+delta may no longer show the remote change, so
 * the planner emits noop/recordBase. Skipping merely because pathLower is already
 * planned would drop the durable retry forever — replace weak plan actions with
 * the retry transfer action.
 */
export function mergeRetryItemsIntoPlan(
  planItems: SyncPlanItem[],
  retryEntries: RetrySetEntry[],
): SyncPlanItem[] {
  if (retryEntries.length === 0) return planItems;
  const retryByPath = new Map(retryEntries.map((entry) => [entry.pathLower, entry]));
  const seen = new Set<string>();
  const merged: SyncPlanItem[] = [];
  let replacedWeak = 0;

  for (const item of planItems) {
    const retry = retryByPath.get(item.pathLower);
    // Planner same_content becomes recordBase (G4). That must not win over a
    // durable deferred/failed download still waiting in retrySet.
    if (retry && isWeakPlanAction(item.action.type) && !isWeakPlanAction(retry.action.type)) {
      replacedWeak++;
      merged.push({
        pathLower: retry.pathLower,
        localPath: retry.localPath,
        action: retry.action,
      });
      seen.add(item.pathLower);
      continue;
    }
    merged.push(item);
    seen.add(item.pathLower);
  }

  const extras: SyncPlanItem[] = [];
  for (const entry of retryEntries) {
    if (seen.has(entry.pathLower)) continue;
    extras.push({
      pathLower: entry.pathLower,
      localPath: entry.localPath,
      action: entry.action,
    });
  }

  if (replacedWeak === 0 && extras.length === 0) return planItems;
  return [...merged, ...extras];
}

function isWeakPlanAction(actionType: string): boolean {
  return actionType === "noop" || actionType === "recordBase";
}

export function buildRetrySetAfterCycle(
  previous: RetrySetEntry[],
  result: {
    succeeded: SyncPlanItem[];
    failed: { item: SyncPlanItem; error: Error }[];
    deferred?: SyncPlanItem[];
  },
  now = Date.now(),
): RetrySetEntry[] {
  const byPath = new Map<string, RetrySetEntry>();
  for (const entry of previous) {
    byPath.set(entry.pathLower, entry);
  }
  for (const item of result.succeeded) {
    const pending = byPath.get(item.pathLower);
    // recordBase/noop success must not drop a pending download/upload retry.
    if (pending && isWeakPlanAction(item.action.type) && !isWeakPlanAction(pending.action.type)) {
      continue;
    }
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
  // G10: deferred open/dirty applies must survive cursor checkpoint + longpoll.
  for (const item of result.deferred ?? []) {
    byPath.set(item.pathLower, {
      pathLower: item.pathLower,
      localPath: item.localPath,
      action: item.action,
      errorMessage: "deferred: open or dirty editor",
      addedAt: byPath.get(item.pathLower)?.addedAt ?? now,
    });
  }
  return [...byPath.values()];
}
