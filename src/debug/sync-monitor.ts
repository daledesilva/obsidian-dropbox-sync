/**
 * Structured sync monitoring for vault debug logs + Cursor Debug Wi‑Fi ingest.
 *
 * Permanent tags (hypothesisId "sync") stay for ongoing user diagnosis.
 * Investigation tags (H-A…H-E) isolate delete/stall/cursor flakiness on mobile.
 */
import type { CursorDebugLogMeta } from "./cursor-debug-ingest";

export type SyncMonitorLog = (
  message: string,
  data?: Record<string, unknown>,
  meta?: CursorDebugLogMeta,
) => void;

/** Stable investigation ids for iPad delete/stall flakiness. */
export const SyncHypotheses = {
  /** Deletes approved but not executed / failed → same files next sync */
  deleteNotExecuted: "H-A",
  /** Incomplete local scan re-infers deletes every cycle */
  reInferDeletes: "H-B",
  /** Delete guard skips (modal false / concurrent) so deletes never run */
  guardSkip: "H-C",
  /** Cursor not advanced → sync loops on same remote delta */
  cursorStall: "H-D",
  /** Individual items timeout / hang → sync feels endless */
  itemStall: "H-E",
  /** General sync phase / progress monitoring (keep for users) */
  sync: "sync",
} as const;

export type SyncHypothesisId = (typeof SyncHypotheses)[keyof typeof SyncHypotheses];

/** Count plan/result items by action type for compact log payloads. */
export function countByActionType(
  items: Iterable<{ action: { type: string } }>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const t = item.action.type;
    counts[t] = (counts[t] ?? 0) + 1;
  }
  return counts;
}

/** Cap path samples so NDJSON lines stay readable on mobile. */
export function samplePaths(paths: Iterable<string>, limit = 8): string[] {
  const out: string[] = [];
  for (const p of paths) {
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

export function createSyncMonitorLog(
  log: (msg: string, data?: unknown, meta?: CursorDebugLogMeta) => void | Promise<void>,
): SyncMonitorLog {
  return (message, data, meta) => {
    void log(message, data, {
      hypothesisId: meta?.hypothesisId ?? SyncHypotheses.sync,
      location: meta?.location ?? "sync-monitor",
      ...(meta?.runId ? { runId: meta.runId } : {}),
    });
  };
}
