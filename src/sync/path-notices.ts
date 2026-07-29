import type { SyncPlanItem } from "../types";

/** Context collected during execute for path-specific notices (G13). */
export interface PathNoticeContext {
  /** Remote path_display after download/upload when it differs from localPath. */
  remotePathDisplay?: string;
}

/** Reasons that warrant an explanatory notice beyond action counts (G13).
 *
 * Runbook-dependent notices — do not remove these reason keys without updating
 * runbooks 01 / 04 (R5 restore, R10 conflict-copy, case-only adopt_remote_casing).
 */
const REASON_MESSAGES: Record<string, (path: string) => string> = {
  local_modified_remote_deleted: (path) =>
    `Dropbox Sync: restored "${path}" — you edited it after it was deleted on Dropbox.`,
  remote_modified_local_deleted: (path) =>
    `Dropbox Sync: restored "${path}" — Dropbox had a newer version after you deleted it locally.`,
  missing_local_restored: (path) =>
    `Dropbox Sync: restored "${path}" — it was missing locally but still exists on Dropbox.`,
  r10_deletion_evidence: (path) =>
    `Dropbox Sync: kept your edits of "${path}" as a conflict copy — Dropbox still shows this path as deleted.`,
  adopt_remote_casing: (path) =>
    `Dropbox Sync: matched Dropbox spelling for "${path}" (same file, different capitalisation).`,
  rename_duplicate_survival: (path) =>
    `Dropbox Sync: kept both renamed copies — "${path}" survived alongside its duplicate.`,
  dual_rename_survival: (path) =>
    `Dropbox Sync: kept both folder renames — "${path}" exists under the name Dropbox kept.`,
};

function actionReason(item: SyncPlanItem): string | null {
  const action = item.action;
  if ("reason" in action && typeof action.reason === "string") {
    return action.reason;
  }
  return null;
}

function isCaseOnlyPathChange(localPath: string, remotePathDisplay: string): boolean {
  return (
    localPath.toLowerCase() === remotePathDisplay.toLowerCase()
    && localPath !== remotePathDisplay
  );
}

/**
 * Build a user-facing notice when a surprising sync outcome needs explanation (G13).
 * Returns null when the action is ordinary upload/download noise.
 */
export function buildPathNotice(
  item: SyncPlanItem,
  context?: PathNoticeContext,
): string | null {
  const reason = actionReason(item);
  if (reason && REASON_MESSAGES[reason]) {
    return REASON_MESSAGES[reason](item.localPath);
  }

  const remoteDisplay = context?.remotePathDisplay;
  if (
    remoteDisplay
    && isCaseOnlyPathChange(item.localPath, remoteDisplay)
    && (item.action.type === "download" || item.action.type === "recordBase")
  ) {
    return REASON_MESSAGES.adopt_remote_casing!(item.localPath);
  }

  if (item.action.type === "preserveAsConflictCopy") {
    return REASON_MESSAGES.r10_deletion_evidence!(item.localPath);
  }

  if (item.conflictSiblingPath && item.action.type === "conflict") {
    return REASON_MESSAGES.rename_duplicate_survival!(item.localPath);
  }

  return null;
}
