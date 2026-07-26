/**
 * Durable set of path_lower values the user deferred on the R6 upload ask
 * ("Cancel" / skip for now). Survives cursor commit so the next sync re-asks
 * instead of silently uploading once the device is considered linked.
 */

export const RESURRECTION_DEFERRED_META_KEY = "resurrectionDeferredSet";

export function parseResurrectionDeferredSet(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .map((value) => value.toLowerCase());
  } catch {
    return [];
  }
}

export function serializeResurrectionDeferredSet(pathLowers: string[]): string {
  const unique = [...new Set(pathLowers.map((p) => p.toLowerCase()))].sort();
  return JSON.stringify(unique);
}

/** Merge remember/clear patches into the prior durable defer set. */
export function mergeResurrectionDeferredSet(
  previous: string[],
  remember: string[],
  clear: string[],
): string[] {
  const next = new Set(previous.map((p) => p.toLowerCase()));
  for (const path of remember) next.add(path.toLowerCase());
  for (const path of clear) next.delete(path.toLowerCase());
  return [...next].sort();
}
