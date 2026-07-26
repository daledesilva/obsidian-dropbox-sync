import type { RemoteStorage } from "../adapters/interfaces";
import type { SyncPlan, SyncPlanItem } from "../types";
import { emptySyncPlanStats } from "../types";
import { logRule, SyncRules, type SyncMonitorLog } from "../debug/sync-monitor";
import { logTemp } from "../debug/temp-log";

/** User choice when list_revisions finds no deletion evidence (G3 / R6). */
export type ResurrectionChoice = "upload" | "discard";

export type ResurrectionResolver = (localPath: string) => Promise<ResurrectionChoice>;

const MAX_REVISION_CHECKS_PER_CYCLE = 20;

function hasDeletionEvidence(
  revisions: { deleted: boolean }[],
): boolean {
  return revisions.some((r) => r.deleted);
}

/**
 * Gate new_local uploads through list_revisions (R6) and optional user confirm.
 * Deletion evidence → preserveAsConflictCopy (R10); no evidence → ask; never silent upload.
 */
export async function applyResurrectionGuard(
  plan: SyncPlan,
  remote: RemoteStorage,
  options: {
    resolver?: ResurrectionResolver;
    log?: SyncMonitorLog;
  },
): Promise<SyncPlan> {
  if (!remote.listRevisions) {
    logTemp(options.log, "P3", "listRevisions unavailable — deferring new_local uploads to resolver", {
      newLocalCount: plan.items.filter(
        (i) => i.action.type === "upload" && i.action.reason === "new_local",
      ).length,
    }, { level: "warn", location: "resurrection-guard.apply" });
  }

  let checksRemaining = MAX_REVISION_CHECKS_PER_CYCLE;
  const items: SyncPlanItem[] = [];

  for (const item of plan.items) {
    const action = item.action;
    if (action.type !== "upload" || action.reason !== "new_local") {
      items.push(item);
      continue;
    }

    if (!remote.listRevisions) {
      if (!options.resolver) {
        logTemp(options.log, "P3", "new_local held — no listRevisions and no resolver", {
          path: item.localPath,
        }, { location: "resurrection-guard.apply" });
        continue;
      }
      const choice = await options.resolver(item.localPath);
      if (choice === "upload") {
        items.push(item);
      } else {
        items.push({
          ...item,
          action: { type: "deleteLocal", reason: "resurrection_discarded" },
        });
      }
      continue;
    }

    if (checksRemaining <= 0) {
      logTemp(options.log, "P3", "list_revisions batch limit reached — deferring path", {
        path: item.localPath,
        limit: MAX_REVISION_CHECKS_PER_CYCLE,
      }, { location: "resurrection-guard.apply" });
      items.push(item);
      continue;
    }

    checksRemaining--;
    let revisions;
    try {
      revisions = await remote.listRevisions(item.localPath);
    } catch (err) {
      logTemp(options.log, "P3", "list_revisions failed — asking user", {
        path: item.localPath,
        error: err instanceof Error ? err.message : String(err),
      }, { level: "warn", location: "resurrection-guard.apply" });
      if (!options.resolver) continue;
      const choice = await options.resolver(item.localPath);
      if (choice === "upload") items.push(item);
      else {
        items.push({
          ...item,
          action: { type: "deleteLocal", reason: "resurrection_discarded" },
        });
      }
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
      items.push({
        ...item,
        action: { type: "preserveAsConflictCopy", reason: "r10_deletion_evidence" },
      });
      continue;
    }

    if (!options.resolver) {
      logTemp(options.log, "P3", "new_local held — no deletion evidence and no resolver", {
        path: item.localPath,
      }, { location: "resurrection-guard.apply" });
      continue;
    }

    const choice = await options.resolver(item.localPath);
    if (choice === "upload") {
      items.push(item);
    } else {
      items.push({
        ...item,
        action: { type: "deleteLocal", reason: "resurrection_discarded" },
      });
    }
  }

  return { items, stats: replanStats(items, plan.stats) };
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
