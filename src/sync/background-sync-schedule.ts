/**
 * Pure scheduling decisions for vault-event debounce and open-file leaf flush.
 * Kept free of Obsidian so quiet-window / flush rules can be unit-tested.
 *
 * Timers and syncNow stay in main.ts — these helpers only answer *what* to do.
 */

export type VaultActivityDecision =
  | { kind: "pending" }
  | { kind: "arm"; delayMs: number };

/**
 * Local vault activity while a cycle runs must not arm a mid-sync timer —
 * that used to fire shortly after upload and re-upload every autosave.
 */
export function decideVaultActivityScheduling(input: {
  syncing: boolean;
  debounceMs: number;
}): VaultActivityDecision {
  if (input.syncing) return { kind: "pending" };
  return { kind: "arm", delayMs: input.debounceMs };
}

export type DebounceFireDecision =
  | { kind: "pending" }
  | { kind: "rearm"; remainingMs: number }
  | { kind: "sync" };

/**
 * Start sync only after a full quiet window since lastVaultEventAt.
 * Mid-window fires re-arm the remaining quiet time instead of syncing early.
 */
export function decideDebounceFire(input: {
  syncing: boolean;
  lastVaultEventAt: number | null;
  now: number;
  debounceMs: number;
}): DebounceFireDecision {
  const quietMs =
    input.lastVaultEventAt != null
      ? input.now - input.lastVaultEventAt
      : input.debounceMs;
  if (input.syncing) return { kind: "pending" };
  if (quietMs < input.debounceMs) {
    return { kind: "rearm", remainingMs: input.debounceMs - quietMs };
  }
  return { kind: "sync" };
}

/**
 * After a cycle, mid-cycle vault edits only set pendingDebouncedSync — callers
 * must re-arm a *full* quiet window (not the leftover timer) so continuous
 * typing does not stampede uploads ~0.5s after each cycle.
 */
export function shouldRearmDebounceAfterPendingVaultActivity(input: {
  backgroundEnabled: boolean;
  pendingDebouncedSync: boolean;
}): boolean {
  return input.backgroundEnabled && input.pendingDebouncedSync;
}

/**
 * Immediate sync trigger for unlocked deferred downloads on leaf change.
 * Must not share the vault-event debounce path — remote bytes are already known.
 */
export const LEAF_FLUSH_DEFERRED_TRIGGER = "leaf:flush-deferred";

/**
 * Whether click-away / leaf change should run an immediate syncNow to apply
 * deferred open-file downloads that are no longer bound to an open editor.
 */
export function shouldFlushDeferredApplies(input: {
  backgroundEnabled: boolean;
  syncing: boolean;
  retryLocalPaths: string[];
  stillDeferred: (localPath: string) => boolean;
}): boolean {
  if (!input.backgroundEnabled || input.syncing) return false;
  if (input.retryLocalPaths.length === 0) return false;
  return input.retryLocalPaths.some((path) => !input.stillDeferred(path));
}
