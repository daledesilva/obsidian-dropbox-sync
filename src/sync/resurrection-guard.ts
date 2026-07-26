import type { RemoteStorage } from "../adapters/interfaces";
import type { SyncPlan, SyncPlanItem } from "../types";
import { emptySyncPlanStats } from "../types";
import { logRule, SyncRules, type SyncMonitorLog } from "../debug/sync-monitor";
import { logTemp } from "../debug/temp-log";

/**
 * User choice when list_revisions finds no deletion evidence (G3 / R6).
 * `defer` = skip this cycle (Cancel); never treat dialog dismiss as discard.
 */
export type ResurrectionChoice = "upload" | "discard" | "defer";

/** One decision for every ambiguous new_local path in the cycle (batch ask). */
export type ResurrectionResolver = (localPaths: string[]) => Promise<ResurrectionChoice>;

const MAX_REVISION_CHECKS_PER_CYCLE = 20;

function hasDeletionEvidence(
  revisions: { deleted: boolean }[],
): boolean {
  return revisions.some((r) => r.deleted);
}

/**
 * Gate new_local uploads through list_revisions (R6) and optional user confirm.
 * Deletion evidence → preserveAsConflictCopy (R10); no evidence → ask once for the
 * whole batch; never silent upload and never treat Cancel as discard.
 *
 * Fresh join (no cursor): all new_local without deletion evidence are asked.
 * Linked device (has cursor): normal new_local uploads freely, BUT paths the user
 * previously deferred ("skip for now") stay gated until Upload/Discard.
 */
export interface ResurrectionGuardResult {
  plan: SyncPlan;
  /** new_local paths held this cycle because the user deferred/cancelled the R6 ask. */
  deferredNewLocalCount: number;
  /** path_lower values to remember as deferred until the user decides. */
  deferPathsToRemember: string[];
  /** path_lower values resolved this cycle (upload or discard) — drop from durable set. */
  deferPathsToClear: string[];
}

export async function applyResurrectionGuard(
  plan: SyncPlan,
  remote: RemoteStorage,
  options: {
    resolver?: ResurrectionResolver;
    log?: SyncMonitorLog;
    /** When true, skip R6/R10 for ordinary new_local — except previously deferred paths. */
    hasSyncCursor?: boolean;
    /** path_lower set from prior Cancel / skip-for-now choices. */
    previouslyDeferredPathLowers?: ReadonlySet<string>;
  },
): Promise<ResurrectionGuardResult> {
  const previouslyDeferred = options.previouslyDeferredPathLowers ?? new Set<string>();

  if (options.hasSyncCursor) {
    return applyDeferredOnlyGuard(plan, options.resolver, previouslyDeferred, options.log);
  }

  if (!remote.listRevisions) {
    logTemp(options.log, "P3", "listRevisions unavailable — deferring new_local uploads to resolver", {
      newLocalCount: plan.items.filter(
        (i) => i.action.type === "upload" && i.action.reason === "new_local",
      ).length,
    }, { level: "warn", location: "resurrection-guard.apply" });
  }

  let checksRemaining = MAX_REVISION_CHECKS_PER_CYCLE;
  const kept: SyncPlanItem[] = [];
  /** Paths that need a user decision (no deletion evidence / API gap). */
  const askItems: SyncPlanItem[] = [];

  for (const item of plan.items) {
    const action = item.action;
    if (action.type !== "upload" || action.reason !== "new_local") {
      kept.push(item);
      continue;
    }

    if (!remote.listRevisions) {
      askItems.push(item);
      continue;
    }

    if (checksRemaining <= 0) {
      // Past the per-cycle API budget: still include in the single ask batch rather
      // than silently uploading (R6) or prompting once per path.
      askItems.push(item);
      continue;
    }

    checksRemaining--;
    let revisions;
    try {
      revisions = await remote.listRevisions(item.localPath);
    } catch (err) {
      logTemp(options.log, "P3", "list_revisions failed — including path in ask batch", {
        path: item.localPath,
        error: err instanceof Error ? err.message : String(err),
      }, { level: "warn", location: "resurrection-guard.apply" });
      askItems.push(item);
      continue;
    }

    logRule(options.log, [SyncRules.R6, SyncRules.R10], "list_revisions checked for resurrection risk", {
      path: item.localPath,
      revisionCount: revisions.length,
      hasDeletionEvidence: hasDeletionEvidence(revisions),
    }, { location: "resurrection-guard.apply" });

    if (hasDeletionEvidence(revisions)) {
      logTemp(options.log, "P3", "R10 — deletion evidence; preserving as conflict copy", {
        path: item.localPath,
        revisionCount: revisions.length,
      }, { location: "resurrection-guard.apply" });
      kept.push({
        ...item,
        action: { type: "preserveAsConflictCopy", reason: "r10_deletion_evidence" },
      });
      continue;
    }

    askItems.push(item);
  }

  return resolveAskBatch(kept, askItems, plan.stats, options.resolver, options.log);
}

/**
 * Linked devices: only re-prompt paths the user already deferred. Other new_local
 * uploads proceed (intentional creates after the device is linked).
 */
async function applyDeferredOnlyGuard(
  plan: SyncPlan,
  resolver: ResurrectionResolver | undefined,
  previouslyDeferred: ReadonlySet<string>,
  log?: SyncMonitorLog,
): Promise<ResurrectionGuardResult> {
  const kept: SyncPlanItem[] = [];
  const askItems: SyncPlanItem[] = [];

  for (const item of plan.items) {
    const action = item.action;
    if (
      action.type === "upload"
      && action.reason === "new_local"
      && previouslyDeferred.has(item.pathLower)
    ) {
      askItems.push(item);
      continue;
    }
    kept.push(item);
  }

  if (askItems.length === 0) {
    logTemp(log, "P3", "resurrection guard skipped — device has sync cursor", {
      newLocalCount: plan.items.filter(
        (i) => i.action.type === "upload" && i.action.reason === "new_local",
      ).length,
      previouslyDeferredSize: previouslyDeferred.size,
    }, { location: "resurrection-guard.apply" });
    return {
      plan,
      deferredNewLocalCount: 0,
      deferPathsToRemember: [],
      deferPathsToClear: [],
    };
  }

  logTemp(log, "P3", "re-asking previously deferred new_local paths despite sync cursor", {
    count: askItems.length,
    sample: askItems.slice(0, 5).map((i) => i.localPath),
  }, { location: "resurrection-guard.apply" });

  return resolveAskBatch(kept, askItems, plan.stats, resolver, log);
}

async function resolveAskBatch(
  kept: SyncPlanItem[],
  askItems: SyncPlanItem[],
  priorStats: SyncPlan["stats"],
  resolver: ResurrectionResolver | undefined,
  log?: SyncMonitorLog,
): Promise<ResurrectionGuardResult> {
  if (askItems.length === 0) {
    return {
      plan: { items: kept, stats: replanStats(kept, priorStats) },
      deferredNewLocalCount: 0,
      deferPathsToRemember: [],
      deferPathsToClear: [],
    };
  }

  const askPathLowers = askItems.map((i) => i.pathLower);

  if (!resolver) {
    logTemp(log, "P3", "new_local held — no deletion evidence and no resolver", {
      count: askItems.length,
      sample: askItems.slice(0, 5).map((i) => i.localPath),
    }, { location: "resurrection-guard.apply" });
    return {
      plan: { items: kept, stats: replanStats(kept, priorStats) },
      deferredNewLocalCount: askItems.length,
      deferPathsToRemember: askPathLowers,
      deferPathsToClear: [],
    };
  }

  const paths = askItems.map((i) => i.localPath);
  logTemp(log, "P3", "R6 ask — batch confirm for paths with no deletion evidence", {
    count: paths.length,
    sample: paths.slice(0, 5),
  }, { location: "resurrection-guard.apply" });

  const choice = await resolver(paths);
  if (choice === "defer") {
    logTemp(log, "P3", "R6 ask deferred — holding new_local uploads this cycle", {
      count: paths.length,
    }, { location: "resurrection-guard.apply" });
    return {
      plan: { items: kept, stats: replanStats(kept, priorStats) },
      deferredNewLocalCount: askItems.length,
      deferPathsToRemember: askPathLowers,
      deferPathsToClear: [],
    };
  }

  for (const item of askItems) {
    if (choice === "upload") {
      kept.push(item);
    } else {
      kept.push({
        ...item,
        action: { type: "deleteLocal", reason: "resurrection_discarded" },
      });
    }
  }

  return {
    plan: { items: kept, stats: replanStats(kept, priorStats) },
    deferredNewLocalCount: 0,
    deferPathsToRemember: [],
    deferPathsToClear: askPathLowers,
  };
}

function replanStats(
  items: SyncPlanItem[],
  prior: SyncPlan["stats"],
): SyncPlan["stats"] {
  const stats = emptySyncPlanStats();
  stats.noop = prior.noop;
  stats.recordBase = prior.recordBase;
  for (const item of items) {
    const t = item.action.type;
    if (t in stats && t !== "noop") {
      (stats as Record<string, number>)[t]++;
    }
  }
  return stats;
}
