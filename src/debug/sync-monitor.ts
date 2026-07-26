/**
 * Structured sync monitoring for vault debug logs + Cursor Debug Wi‑Fi ingest.
 *
 * Permanent tags (hypothesisId "sync") stay for ongoing user diagnosis.
 * Investigation tags (H-A…H-E) isolate delete/stall/cursor flakiness on mobile.
 */
import type { CursorDebugLogMeta, SyncLogLevel } from "./cursor-debug-ingest";

export type SyncMonitorLog = (
  message: string,
  data?: Record<string, unknown>,
  meta?: CursorDebugLogMeta,
) => void;

/**
 * Coarse subsystem tags. Combined with `ruleId` these let a reader filter the
 * NDJSON stream down to "why did sync decide that" without reading source.
 */
export const SyncLogCategories = {
  /** Cycle lifecycle: start, end, trigger, scheduling */
  cycle: "cycle",
  /** Local filesystem scan and scope filtering */
  scan: "scan",
  /** Remote listing, cursor deltas, remote snapshot construction */
  remote: "remote",
  /** Per-file base state reads and writes */
  base: "base",
  /** A named rule (R1-R14) or principle (P1-P5) being evaluated */
  rule: "rule",
  /** Planner classification of a single path */
  decision: "decision",
  /** Delete guard, path guard, folder-coalesce eligibility */
  guard: "guard",
  /** Executor dispatch and batching */
  execute: "execute",
  /** Actual bytes moving: upload, download, move, delete */
  transfer: "transfer",
  /** Sync state store mutations */
  state: "state",
  /** Cursor advancement and the reasons it was withheld */
  cursor: "cursor",
  /** Conflict detection and resolution */
  conflict: "conflict",
  /** Deferrals and their bounds */
  defer: "defer",
  /** User-facing notices */
  notice: "notice",
} as const;

export type SyncLogCategory = (typeof SyncLogCategories)[keyof typeof SyncLogCategories];

/**
 * The principles and rules from docs/sync-scenarios.md, as constants so a rule
 * tag can never be a typo'd string. Every R* here must have at least one log
 * call site — see test/sync-log-taxonomy.test.ts, which fails if one does not.
 */
export const SyncRules = {
  /** Vault is a folder of ordinary files; no bookkeeping written into it */
  P1: "P1",
  /** The copy on Dropbox is also a valid vault */
  P2: "P2",
  /** Plugin and Dropbox desktop client are both valid sync approaches */
  P3: "P3",
  /** Operations must work without Obsidian settings or plugins syncing */
  P4: "P4",
  /** Manual sync and live sync must produce the same outcomes */
  P5: "P5",

  /** Never let a conflict destroy content in either direction */
  R1: "R1",
  /** The version already on Dropbox keeps the canonical name */
  R2: "R2",
  /** Conflict copies are ordinary files and must sync everywhere */
  R3: "R3",
  /** A conflict copy names the device that produced it */
  R4: "R4",
  /** An edit beats a delete */
  R5: "R5",
  /** A delete needs durable evidence; without it, ask */
  R6: "R6",
  /** Never write directly to the destination file */
  R7: "R7",
  /** Content hashes decide what changed; dates only break safe ties */
  R8: "R8",
  /** Removing many files at once needs confirmation */
  R9: "R9",
  /** Durable delete evidence plus local bytes becomes a conflict copy */
  R10: "R10",
  /** Changing the linked folder is a re-link, not a mass delete */
  R11: "R11",
  /** Open editors may delay apply or delete; every deferral is bounded */
  R12: "R12",
  /** Debounce to settled bursts; one unresolved conflict copy per device per path */
  R13: "R13",
  /** Folder-level operations need a confirmed membership match */
  R14: "R14",
} as const;

export type SyncRuleId = (typeof SyncRules)[keyof typeof SyncRules];

/** Every rule id, for taxonomy coverage checks. */
export const ALL_SYNC_RULE_IDS: SyncRuleId[] = Object.values(SyncRules);

/** Rule ids only (excludes the P* principles), which is what coverage asserts on. */
export const ALL_SYNC_RULE_IDS_R_ONLY: SyncRuleId[] = ALL_SYNC_RULE_IDS.filter((id) =>
  id.startsWith("R"),
);

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
      ...(meta?.level ? { level: meta.level } : {}),
      ...(meta?.category ? { category: meta.category } : {}),
      ...(meta?.ruleId ? { ruleId: meta.ruleId } : {}),
      ...(meta?.scenarioRow !== undefined ? { scenarioRow: meta.scenarioRow } : {}),
      ...(meta?.temp ? { temp: meta.temp } : {}),
    });
  };
}

/**
 * Record that a named rule was consulted — including when it changed nothing.
 *
 * Rules that only log when they fire are indistinguishable from rules that were
 * never reached, which is the single most common reason a sync bug takes a
 * whole session to localise. A pass is evidence too.
 */
export function logRule(
  log: SyncMonitorLog | undefined,
  ruleId: SyncRuleId | SyncRuleId[],
  message: string,
  data?: Record<string, unknown>,
  meta?: Omit<CursorDebugLogMeta, "ruleId" | "category">,
): void {
  log?.(message, data, {
    ...meta,
    category: SyncLogCategories.rule,
    ruleId,
    level: meta?.level ?? "debug",
  });
}

/** Three-way comparison inputs behind a single planner decision. */
export type DecisionInputs = {
  pathLower: string;
  localPath?: string;
  localHash: string | null;
  remoteHash: string | null;
  baseLocalHash: string | null;
  baseRemoteHash: string | null;
  basePathDisplay?: string | null;
  rev?: string | null;
  localDeleteIntended?: boolean;
};

/**
 * Record one planner classification with the full three-way input that produced
 * it. Emitted for every path including `noop`, because "nothing happened here"
 * is exactly the outcome G4 showed we could not previously see.
 *
 * Non-actionable outcomes default to `trace` so a 20k-file vault does not write
 * 20k lines per cycle unless verbose decision logging is on.
 */
export function logDecision(
  log: SyncMonitorLog | undefined,
  inputs: DecisionInputs,
  actionType: string,
  reason: string,
  meta?: Omit<CursorDebugLogMeta, "category">,
): void {
  const isActionable = actionType !== "noop";
  log?.("decision", {
    action: actionType,
    reason,
    ...inputs,
  }, {
    ...meta,
    category: SyncLogCategories.decision,
    level: meta?.level ?? (isActionable ? "debug" : "trace"),
    location: meta?.location ?? "planner.classifyChange",
  });
}

/** Shorten a hash for log payloads; full hashes make lines unreadable on mobile. */
export function shortHash(hash: string | null | undefined): string | null {
  if (!hash) return hash ?? null;
  return hash.slice(0, 8);
}

/**
 * Render level/category/rule tags as a compact prefix for the plain-text vault
 * log, which has no structured fields of its own. NDJSON keeps them as fields.
 */
export function formatLogPrefix(meta?: CursorDebugLogMeta): string {
  if (!meta) return "";
  const parts: string[] = [];
  if (meta.level && meta.level !== "debug") parts.push(meta.level.toUpperCase());
  if (meta.category) parts.push(meta.category);
  if (meta.ruleId) {
    parts.push(Array.isArray(meta.ruleId) ? meta.ruleId.join("+") : meta.ruleId);
  }
  if (meta.temp) parts.push(`TEMP:${meta.temp}`);
  return parts.length > 0 ? `[${parts.join("|")}] ` : "";
}
