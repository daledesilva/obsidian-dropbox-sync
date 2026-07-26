/** Working default from sync-scenarios open question 3 (G10). */
export const ACTIVE_FILE_DEFERRAL_MS = 60_000;

/**
 * Per-path first-defer timestamps for R12/G10 bounded deferral.
 * Device-local in memory — deferral state resets on plugin reload, which is acceptable.
 */
export class DeferralTracker {
  private firstDeferredAt = new Map<string, number>();

  constructor(private readonly boundMs = ACTIVE_FILE_DEFERRAL_MS) {}

  markDeferred(path: string, now = Date.now()): void {
    if (!this.firstDeferredAt.has(path)) {
      this.firstDeferredAt.set(path, now);
    }
  }

  clear(path: string): void {
    this.firstDeferredAt.delete(path);
  }

  /** True while the path is still inside the deferral window. */
  isWithinBound(path: string, now = Date.now()): boolean {
    const started = this.firstDeferredAt.get(path);
    if (started === undefined) return true;
    return now - started < this.boundMs;
  }

  boundExpired(path: string, now = Date.now()): boolean {
    const started = this.firstDeferredAt.get(path);
    if (started === undefined) return false;
    return now - started >= this.boundMs;
  }

  elapsedMs(path: string, now = Date.now()): number | undefined {
    const started = this.firstDeferredAt.get(path);
    if (started === undefined) return undefined;
    return now - started;
  }
}
