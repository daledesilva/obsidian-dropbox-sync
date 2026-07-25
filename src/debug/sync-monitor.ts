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
  /**
   * Dual/stale path shapes (e.g. Files/Other/Ink vs Files/Other/Files/Ink).
   * Used to confirm whether paths are newly created or only leftover history.
   */
  pathShape: "H-path",
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

/**
 * Alternate path for the observed Files/Other vs Files/Other/Files duplication.
 * Returns null when the path is unrelated to that pattern.
 */
export function alternateOtherFilesPath(pathLower: string): string | null {
  const p = pathLower.toLowerCase();
  if (p.includes("files/other/files/")) {
    return p.replace("files/other/files/", "files/other/");
  }
  if (p.includes("files/other/") && !p.includes("files/other/files/")) {
    return p.replace("files/other/", "files/other/files/");
  }
  return null;
}

/** True when path has the nested Files/Other/Files shape from iPad logs. */
export function hasNestedOtherFilesPath(pathLower: string): boolean {
  return pathLower.toLowerCase().includes("files/other/files/");
}

export type DeleteRemotePathShapeRow = {
  path: string;
  intentSource: string;
  nestedOtherFiles: boolean;
  alternatePath: string | null;
  alternateAlsoInPlan: boolean;
  alternateInDeleteLog: boolean;
  inRemote: boolean;
  inLocal: boolean;
};

/**
 * Summarize deleteRemote path-shape anomalies for H-path investigation.
 * Confirms stale dual paths vs newly invented doubles.
 */
export function summarizeDeleteRemotePathShapes(input: {
  deleteRemotePaths: string[];
  deleteLogPaths: Iterable<string>;
  intentSource: (pathLower: string) => string | undefined;
  remotePathLowers: Set<string>;
  localPathLowers: Set<string>;
  sampleLimit?: number;
}): {
  deleteRemoteCount: number;
  nestedOtherFilesCount: number;
  pairCount: number;
  sample: DeleteRemotePathShapeRow[];
} {
  const limit = input.sampleLimit ?? 12;
  const deleteLog = new Set(
    [...input.deleteLogPaths].map((p) => p.toLowerCase()),
  );
  const planSet = new Set(input.deleteRemotePaths.map((p) => p.toLowerCase()));
  const nested = input.deleteRemotePaths.filter((p) => hasNestedOtherFilesPath(p));
  let pairCount = 0;
  const sample: DeleteRemotePathShapeRow[] = [];

  for (const path of input.deleteRemotePaths) {
    const pathLower = path.toLowerCase();
    const alternatePath = alternateOtherFilesPath(pathLower);
    const alternateAlsoInPlan = alternatePath ? planSet.has(alternatePath) : false;
    const alternateInDeleteLog = alternatePath ? deleteLog.has(alternatePath) : false;
    if (alternateAlsoInPlan || alternateInDeleteLog) {
      pairCount++;
    }
    const interesting =
      hasNestedOtherFilesPath(pathLower)
      || alternateAlsoInPlan
      || alternateInDeleteLog;
    if (!interesting || sample.length >= limit) continue;
    sample.push({
      path,
      intentSource: input.intentSource(pathLower) ?? "unknown",
      nestedOtherFiles: hasNestedOtherFilesPath(pathLower),
      alternatePath,
      alternateAlsoInPlan,
      alternateInDeleteLog,
      inRemote: input.remotePathLowers.has(pathLower),
      inLocal: input.localPathLowers.has(pathLower),
    });
  }

  return {
    deleteRemoteCount: input.deleteRemotePaths.length,
    nestedOtherFilesCount: nested.length,
    pairCount,
    sample,
  };
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
