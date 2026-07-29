/** Prohibition sign (circle with slash) — Ghostbusters-style stop for conflicts. */
export const CONFLICT_SUMMARY_ICON = "\u{1F6AB}";

export type ActionSummaryType =
  | "failed"
  | "upload"
  | "download"
  | "rename"
  | "move"
  | "conflict"
  | "deleteLocal"
  | "deleteRemote";

/** One counted action type for string notices and structured panel rendering. */
export interface ActionSummaryPart {
  type: ActionSummaryType;
  count: number;
}

/**
 * Panel / notice order: failed first (matches "N failed, … ok" copy), then
 * transfer actions, renames, moves, then conflicts/deletes.
 * Folder creates fold into upload/download so one direction gets one chip.
 */
const ACTION_ORDER: ActionSummaryType[] = [
  "failed",
  "upload",
  "download",
  "rename",
  "move",
  "conflict",
  "deleteLocal",
  "deleteRemote",
];

/** Separator between action summary parts in notices and explorer detail lines. */
export const ACTION_SUMMARY_SEPARATOR = " \u2022 ";

/** Action-like input for chip classification (executor actions carry from/to on moves). */
export type ActionSummarySource =
  | string
  | { type: string; fromPath?: string; toPath?: string };

function parentDirLower(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const slash = normalized.lastIndexOf("/");
  return (slash < 0 ? "" : normalized.slice(0, slash)).toLowerCase();
}

/**
 * Same-parent path change = rename (including case-only).
 * Different parent = move. Used so the Aa chip covers all renames, not only casing.
 */
export function isSameParentRename(fromPath: string, toPath: string): boolean {
  const fromNorm = fromPath.replace(/\\/g, "/");
  const toNorm = toPath.replace(/\\/g, "/");
  if (fromNorm.toLowerCase() === toNorm.toLowerCase() && fromNorm === toNorm) {
    return false;
  }
  return parentDirLower(fromNorm) === parentDirLower(toNorm);
}

/**
 * Map executor action types onto panel chip categories.
 * Same-parent move* actions → rename (Aa); cross-directory → move (corner arrow).
 * Folder creates count under upload/download so file + folder creations share one chip.
 */
export function toActionSummaryType(action: ActionSummarySource): ActionSummaryType | null {
  const type = typeof action === "string" ? action : action.type;
  const fromPath = typeof action === "string" ? undefined : action.fromPath;
  const toPath = typeof action === "string" ? undefined : action.toPath;

  switch (type) {
    case "failed":
    case "upload":
    case "download":
    case "rename":
    case "move":
    case "conflict":
    case "deleteLocal":
    case "deleteRemote":
      return type;
    case "moveRemote":
    case "moveLocal":
    case "moveRemoteFolder":
    case "moveLocalFolder":
      if (fromPath && toPath && isSameParentRename(fromPath, toPath)) {
        return "rename";
      }
      return "move";
    case "createLocalFolder":
      return "download";
    case "createRemoteFolder":
      return "upload";
    case "deleteLocalFolder":
      return "deleteLocal";
    case "deleteRemoteFolder":
      return "deleteRemote";
    default:
      return null;
  }
}

/** e.g. "🚫 1 conflict" / "🚫 2 conflicts" */
export function formatConflictSummary(count: number): string {
  return `${CONFLICT_SUMMARY_ICON} ${count} conflict${count === 1 ? "" : "s"}`;
}

/** Plain-text value after the icon (panel keeps this colour; icon is styled separately). */
export function formatActionSummaryValue(part: ActionSummaryPart): string {
  if (part.type === "conflict") {
    return `${part.count} conflict${part.count === 1 ? "" : "s"}`;
  }
  // Count-only — the chip icon already signals failure vs transfer.
  return String(part.count);
}

/** Live chip value while execute is still running (e.g. "3 / 10") — for aria/notices. */
export function formatActionProgressValue(completed: number, total: number): string {
  return `${completed} / ${total}`;
}

/** Action types that show live completed/total chips during execute. */
export const LIVE_PROGRESS_ACTION_TYPES: readonly ActionSummaryType[] = [
  "upload",
  "download",
  "rename",
  "move",
];

const LIVE_RAW_MOVE_TYPES = new Set([
  "moveRemote",
  "moveLocal",
  "moveRemoteFolder",
  "moveLocalFolder",
  "move",
  "rename",
]);

/** True when the (raw or summary) action type participates in live chips. */
export function isLiveProgressActionType(type: string): boolean {
  if (LIVE_RAW_MOVE_TYPES.has(type)) return true;
  const summary = toActionSummaryType(type);
  return summary !== null && (LIVE_PROGRESS_ACTION_TYPES as readonly string[]).includes(summary);
}

/** Notice / status-bar string for one part (emoji/arrows + value). */
export function formatActionSummaryPart(part: ActionSummaryPart): string {
  switch (part.type) {
    case "failed":
      // Ballot X — distinct from conflict’s prohibition sign.
      return `\u2717${part.count}`;
    case "upload":
      return `\u2191${part.count}`;
    case "download":
      return `\u2193${part.count}`;
    case "rename":
      // "Aa" — any same-parent rename (including case-only).
      return `Aa${part.count}`;
    case "move":
      // Corner arrow — cross-directory moves.
      return `\u21B3${part.count}`;
    case "conflict":
      return formatConflictSummary(part.count);
    case "deleteLocal":
      // Keep direction (local↓ / remote↑) but use a trash can instead of ✗.
      return `\u2193\u{1F5D1}${part.count}`;
    case "deleteRemote":
      return `\u2191\u{1F5D1}${part.count}`;
  }
}

/** Succeeded paths keyed by action type — chip modals list these per summary chip. */
export type ActionSummaryPaths = Partial<Record<ActionSummaryType, string[]>>;

/**
 * Group succeeded localPaths by action type (upload/download/rename/move/…).
 * Order within each type follows the input order; only ACTION_ORDER types are kept.
 */
export function groupSucceededPathsByAction(
  items: { action: { type: string; fromPath?: string; toPath?: string }; localPath: string }[],
): ActionSummaryPaths {
  const grouped: ActionSummaryPaths = {};
  for (const item of items) {
    const type = toActionSummaryType(item.action);
    if (!type || !ACTION_ORDER.includes(type)) continue;
    const list = grouped[type] ?? [];
    list.push(item.localPath);
    grouped[type] = list;
  }
  return grouped;
}

/** Paths of succeeded conflict actions (thin wrapper over the grouped map). */
export function listConflictPaths(
  items: { action: { type: string; fromPath?: string; toPath?: string }; localPath: string }[],
): string[] {
  return groupSucceededPathsByAction(items).conflict ?? [];
}

/**
 * Merge path lists for deferred deletes onto an existing section summary
 * without wiping upload/download/conflict paths already recorded.
 */
export function mergeActionSummaryPaths(
  existing: ActionSummaryPaths,
  additions: ActionSummaryPaths,
): ActionSummaryPaths {
  const merged: ActionSummaryPaths = {};
  for (const type of ACTION_ORDER) {
    const paths = [...(existing[type] ?? []), ...(additions[type] ?? [])];
    if (paths.length > 0) merged[type] = paths;
  }
  return merged;
}

/** Modal title / chip aria for a summary chip's affected-path list (files or folders). */
export function actionSummaryModalTitle(type: ActionSummaryType): string {
  switch (type) {
    case "failed":
      return "Failed";
    case "upload":
      return "Uploaded";
    case "download":
      return "Downloaded";
    case "rename":
      return "Renamed";
    case "move":
      return "Moved";
    case "deleteLocal":
      // Local vault deletes that mirror cloud removals.
      return "Local Deletions";
    case "deleteRemote":
      return "Cloud Deletions";
    case "conflict":
      return "Conflicted";
  }
}

/**
 * Build panel chips for a sync result: failed first (when any), then succeeded
 * action breakdown. Keeps upload/download/etc. visible instead of collapsing to
 * prose like "8 failed, 406 ok".
 */
export function summarizeResultParts(
  result: {
    succeeded: { action: { type: string; fromPath?: string; toPath?: string }; localPath: string }[];
    failed: { item: { localPath: string; action: { type: string; fromPath?: string; toPath?: string } } }[];
  },
): { summaryParts: ActionSummaryPart[]; summaryPaths: ActionSummaryPaths } {
  const summaryParts = summarizeActionParts(result.succeeded);
  const summaryPaths = groupSucceededPathsByAction(result.succeeded);
  if (result.failed.length === 0) {
    return { summaryParts, summaryPaths };
  }
  // Failed is not an executor action type — attach it from the failure list.
  const failedPaths = result.failed.map((f) => f.item.localPath);
  return {
    summaryParts: mergeActionSummaryParts(
      [{ type: "failed", count: result.failed.length }],
      summaryParts,
    ),
    summaryPaths: {
      ...summaryPaths,
      failed: failedPaths,
    },
  };
}

/** Structured counts for panel icon/value styling. */
export function summarizeActionParts(
  items: { action: { type: string; fromPath?: string; toPath?: string } }[],
): ActionSummaryPart[] {
  const counts: Partial<Record<ActionSummaryType, number>> = {};
  for (const item of items) {
    const type = toActionSummaryType(item.action);
    if (!type || !ACTION_ORDER.includes(type)) continue;
    counts[type] = (counts[type] ?? 0) + 1;
  }
  const parts: ActionSummaryPart[] = [];
  for (const type of ACTION_ORDER) {
    const count = counts[type];
    if (count) parts.push({ type, count });
  }
  return parts;
}

/** 동기화 결과를 아이콘 요약 문자열로 변환. 예: "↑2 • ↓1 • 🚫 1 conflict" */
export function summarizeActions(items: { action: { type: string; fromPath?: string; toPath?: string } }[]): string {
  const parts = summarizeActionParts(items);
  // recordBase / noop succeed without a user-facing transfer chip —
  // never fall back to "N synced" prose (that looked like a transfer with no chip).
  // Folder creates fold into upload/download chips; folder deletes stay visible on trash chips.
  if (parts.length === 0) return "up to date";
  return parts.map(formatActionSummaryPart).join(ACTION_SUMMARY_SEPARATOR);
}

/**
 * Merge new action counts into existing summary parts (e.g. append delete icons
 * after a deferred Deletions phase without wiping upload/download counts).
 */
export function mergeActionSummaryParts(
  existing: ActionSummaryPart[],
  additions: ActionSummaryPart[],
): ActionSummaryPart[] {
  const counts: Partial<Record<ActionSummaryType, number>> = {};
  for (const part of existing) {
    counts[part.type] = (counts[part.type] ?? 0) + part.count;
  }
  for (const part of additions) {
    counts[part.type] = (counts[part.type] ?? 0) + part.count;
  }
  const parts: ActionSummaryPart[] = [];
  for (const type of ACTION_ORDER) {
    const count = counts[type];
    if (count) parts.push({ type, count });
  }
  return parts;
}
