/** Prohibition sign (circle with slash) — Ghostbusters-style stop for conflicts. */
export const CONFLICT_SUMMARY_ICON = "\u{1F6AB}";

export type ActionSummaryType =
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

const ACTION_ORDER: ActionSummaryType[] = [
  "upload",
  "download",
  "conflict",
  "deleteLocal",
  "deleteRemote",
];

/** e.g. "🚫 1 conflict" / "🚫 2 conflicts" */
export function formatConflictSummary(count: number): string {
  return `${CONFLICT_SUMMARY_ICON} ${count} conflict${count === 1 ? "" : "s"}`;
}

/** Plain-text value after the icon (panel keeps this colour; icon is styled separately). */
export function formatActionSummaryValue(part: ActionSummaryPart): string {
  if (part.type === "conflict") {
    return `${part.count} conflict${part.count === 1 ? "" : "s"}`;
  }
  return String(part.count);
}

/** Notice / status-bar string for one part (emoji/arrows + value). */
export function formatActionSummaryPart(part: ActionSummaryPart): string {
  switch (part.type) {
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

/** Paths of succeeded conflict actions, for the explorer progress expand list. */
export function listConflictPaths(
  items: { action: { type: string }; localPath: string }[],
): string[] {
  return items
    .filter((item) => item.action.type === "conflict")
    .map((item) => item.localPath);
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

/** 동기화 결과를 아이콘 요약 문자열로 변환. 예: "↑2 ↓1 🚫 1 conflict" */
export function summarizeActions(items: { action: { type: string } }[]): string {
  const parts = summarizeActionParts(items);
  if (parts.length === 0) return `${items.length} synced`;
  return parts.map(formatActionSummaryPart).join(" ");
}
