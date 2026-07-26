import type { SyncPlanItem, SyncResult } from "../types";

/** Meta key for paths that must not retry every cycle (G17). */
export const PERMANENT_SKIP_META_KEY = "permanentSkipSet";

export type PermanentFailureKind = "disk_full" | "oversized" | "local_path";

export interface PermanentSkipEntry {
  pathLower: string;
  localPath: string;
  kind: PermanentFailureKind;
  errorMessage: string;
  addedAt: number;
}

export function parsePermanentSkipSet(raw: string | null): PermanentSkipEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPermanentSkipEntry);
  } catch {
    return [];
  }
}

function isPermanentSkipEntry(value: unknown): value is PermanentSkipEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as PermanentSkipEntry;
  return (
    typeof entry.pathLower === "string"
    && typeof entry.localPath === "string"
    && typeof entry.kind === "string"
    && typeof entry.errorMessage === "string"
    && typeof entry.addedAt === "number"
  );
}

export function serializePermanentSkipSet(entries: PermanentSkipEntry[]): string {
  return JSON.stringify(entries);
}

/**
 * Classify errors that will not succeed on retry — ENOSPC, quota, oversize local
 * writes, etc. (G17). Returns null when the failure should stay in retrySet.
 */
export function classifyPermanentFailure(error: Error): PermanentFailureKind | null {
  const msg = error.message.toLowerCase();
  const name = error.name.toLowerCase();

  if (
    name === "permanentsyncfailureerror"
    || msg.includes("enospc")
    || msg.includes("no space left")
    || msg.includes("disk full")
    || msg.includes("quota exceeded")
    || msg.includes("insufficient storage")
    || msg.includes("not enough space")
  ) {
    return "disk_full";
  }

  if (
    msg.includes("file too large")
    || msg.includes("entity too large")
    || msg.includes("oversized")
    || msg.includes("exceeds maximum")
    || msg.includes("payload too large")
  ) {
    return "oversized";
  }

  if (name === "localpatherror" || name === "pathvalidationerror") {
    return "local_path";
  }

  return null;
}

/** Thrown from vault write when the failure is permanent (G17). */
export class PermanentSyncFailureError extends Error {
  constructor(
    message: string,
    public readonly kind: PermanentFailureKind,
  ) {
    super(message);
    this.name = "PermanentSyncFailureError";
  }
}

export function mergePermanentSkipAfterCycle(
  previous: PermanentSkipEntry[],
  result: SyncResult,
  now = Date.now(),
): PermanentSkipEntry[] {
  const byPath = new Map<string, PermanentSkipEntry>();
  for (const entry of previous) {
    byPath.set(entry.pathLower, entry);
  }
  for (const item of result.succeeded) {
    byPath.delete(item.pathLower);
  }
  for (const failure of result.failed) {
    const kind = classifyPermanentFailure(failure.error);
    if (!kind) continue;
    byPath.set(failure.item.pathLower, {
      pathLower: failure.item.pathLower,
      localPath: failure.item.localPath,
      kind,
      errorMessage: failure.error.message,
      addedAt: byPath.get(failure.item.pathLower)?.addedAt ?? now,
    });
  }
  return [...byPath.values()];
}

/** Drop plan items that are durably skipped so they do not block the cycle. */
export function filterPermanentSkippedItems(
  items: SyncPlanItem[],
  permanentSkips: PermanentSkipEntry[],
): SyncPlanItem[] {
  if (permanentSkips.length === 0) return items;
  const skipped = new Set(permanentSkips.map((entry) => entry.pathLower));
  return items.filter((item) => !skipped.has(item.pathLower));
}

/** User-facing summary for sync feedback (G17). */
export function summarizePermanentSkips(entries: PermanentSkipEntry[]): string | null {
  if (entries.length === 0) return null;
  const sample = entries.slice(0, 3).map((entry) => entry.localPath).join(", ");
  const suffix = entries.length > 3 ? ` (+${entries.length - 3} more)` : "";
  return `${entries.length} file(s) skipped permanently (${sample}${suffix})`;
}
