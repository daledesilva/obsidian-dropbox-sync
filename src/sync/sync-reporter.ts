/** Prohibition sign (circle with slash) — Ghostbusters-style stop for conflicts. */
export const CONFLICT_SUMMARY_ICON = "\u{1F6AB}";

export type ActionSummaryType =
  | "failed"
  | "upload"
  | "download"
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
 * transfer actions, then conflicts/deletes.
 */
const ACTION_ORDER: ActionSummaryType[] = [
  "failed",
  "upload",
  "download",
  "conflict",
  "deleteLocal",
  "deleteRemote",
];

/** Separator between action summary parts in notices and explorer detail lines. */
export const ACTION_SUMMARY_SEPARATOR = " \u2022 ";

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
];

/** True when the action type participates in live upload/download chips. */
export function isLiveProgressActionType(type: string): type is ActionSummaryType {
  return (LIVE_PROGRESS_ACTION_TYPES as readonly string[]).includes(type);
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
 * Group succeeded localPaths by action type (upload/download/conflict/deletes).
 * Order within each type follows the input order; only ACTION_ORDER types are kept.
 */
export function groupSucceededPathsByAction(
  items: { action: { type: string }; localPath: string }[],
): ActionSummaryPaths {
  const grouped: ActionSummaryPaths = {};
  for (const item of items) {
    const type = item.action.type as ActionSummaryType;
    if (!ACTION_ORDER.includes(type)) continue;
    const list = grouped[type] ?? [];
    list.push(item.localPath);
    grouped[type] = list;
  }
  return grouped;
}

/** Paths of succeeded conflict actions (thin wrapper over the grouped map). */
export function listConflictPaths(
  items: { action: { type: string }; localPath: string }[],
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

/** Modal title for a summary chip's affected-file list. */
export function actionSummaryModalTitle(type: ActionSummaryType): string {
  switch (type) {
    case "failed":
      return "Failed Files";
    case "upload":
      return "Uploaded Files";
    case "download":
      return "Downloaded Files";
    case "deleteLocal":
      // Local vault deletes that mirror cloud removals.
      return "Local Deletions";
    case "deleteRemote":
      return "Cloud Deletions";
    case "conflict":
      return "Conflicted Files";
  }
}

/**
 * Build panel chips for a sync result: failed first (when any), then succeeded
 * action breakdown. Keeps upload/download/etc. visible instead of collapsing to
 * prose like "8 failed, 406 ok".
 */
export function summarizeResultParts(
  result: {
    succeeded: { action: { type: string }; localPath: string }[];
    failed: { item: { localPath: string; action: { type: string } } }[];
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
  items: { action: { type: string } }[],
): ActionSummaryPart[] {
  const counts: Partial<Record<ActionSummaryType, number>> = {};
  for (const item of items) {
    const type = item.action.type as ActionSummaryType;
    if (!ACTION_ORDER.includes(type)) continue;
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
export function summarizeActions(items: { action: { type: string } }[]): string {
  const parts = summarizeActionParts(items);
  // recordBase / mkdir / noop succeed without a user-facing transfer chip —
  // never fall back to "N synced" prose (that looked like a transfer with no chip).
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
