import { describe, expect, test } from "bun:test";
import {
  decideDebounceFire,
  decideVaultActivityScheduling,
  LEAF_FLUSH_DEFERRED_TRIGGER,
  shouldFlushDeferredApplies,
  shouldRearmDebounceAfterPendingVaultActivity,
} from "@/sync/background-sync-schedule";

const DEBOUNCE_MS = 5_000;

describe("decideVaultActivityScheduling", () => {
  test("idle vault event arms full debounce window", () => {
    expect(
      decideVaultActivityScheduling({ syncing: false, debounceMs: DEBOUNCE_MS }),
    ).toEqual({ kind: "arm", delayMs: DEBOUNCE_MS });
  });

  test("event while syncing only marks pending (no mid-cycle arm)", () => {
    expect(
      decideVaultActivityScheduling({ syncing: true, debounceMs: DEBOUNCE_MS }),
    ).toEqual({ kind: "pending" });
  });
});

describe("decideDebounceFire", () => {
  test("full quiet window → sync", () => {
    expect(
      decideDebounceFire({
        syncing: false,
        lastVaultEventAt: 1_000,
        now: 1_000 + DEBOUNCE_MS,
        debounceMs: DEBOUNCE_MS,
      }),
    ).toEqual({ kind: "sync" });
  });

  test("quietMs < debounceMs → rearm remaining, do not sync early", () => {
    expect(
      decideDebounceFire({
        syncing: false,
        lastVaultEventAt: 1_000,
        now: 1_000 + 2_000,
        debounceMs: DEBOUNCE_MS,
      }),
    ).toEqual({ kind: "rearm", remainingMs: 3_000 });
  });

  test("fire while syncing → pending", () => {
    expect(
      decideDebounceFire({
        syncing: true,
        lastVaultEventAt: 1_000,
        now: 1_000 + DEBOUNCE_MS,
        debounceMs: DEBOUNCE_MS,
      }),
    ).toEqual({ kind: "pending" });
  });

  test("no lastVaultEventAt treats quiet as already satisfied", () => {
    expect(
      decideDebounceFire({
        syncing: false,
        lastVaultEventAt: null,
        now: 9_999,
        debounceMs: DEBOUNCE_MS,
      }),
    ).toEqual({ kind: "sync" });
  });

  test("rapid events: only last quiet window allows fire", () => {
    // Simulate continuous typing: each event resets lastVaultEventAt.
    let lastVaultEventAt = 0;
    const events = [0, 1_500, 3_000, 4_500];
    for (const t of events) {
      lastVaultEventAt = t;
      const early = decideDebounceFire({
        syncing: false,
        lastVaultEventAt,
        now: t + 2_000,
        debounceMs: DEBOUNCE_MS,
      });
      expect(early.kind).toBe("rearm");
    }
    expect(
      decideDebounceFire({
        syncing: false,
        lastVaultEventAt,
        now: lastVaultEventAt + DEBOUNCE_MS,
        debounceMs: DEBOUNCE_MS,
      }),
    ).toEqual({ kind: "sync" });
  });
});

describe("shouldRearmDebounceAfterPendingVaultActivity", () => {
  test("re-arms full quiet window after cycle when vault activity was pending", () => {
    expect(
      shouldRearmDebounceAfterPendingVaultActivity({
        backgroundEnabled: true,
        pendingDebouncedSync: true,
      }),
    ).toBe(true);
  });

  test("does not re-arm when nothing pending or background off", () => {
    expect(
      shouldRearmDebounceAfterPendingVaultActivity({
        backgroundEnabled: true,
        pendingDebouncedSync: false,
      }),
    ).toBe(false);
    expect(
      shouldRearmDebounceAfterPendingVaultActivity({
        backgroundEnabled: false,
        pendingDebouncedSync: true,
      }),
    ).toBe(false);
  });
});

describe("shouldFlushDeferredApplies", () => {
  test("unlocked retry → flush true (immediate leaf sync, not vault debounce)", () => {
    expect(LEAF_FLUSH_DEFERRED_TRIGGER).toBe("leaf:flush-deferred");
    expect(
      shouldFlushDeferredApplies({
        backgroundEnabled: true,
        syncing: false,
        retryLocalPaths: ["open.md"],
        stillDeferred: () => false,
      }),
    ).toBe(true);
  });

  test("empty retry / all still deferred / syncing / bg off → no flush", () => {
    expect(
      shouldFlushDeferredApplies({
        backgroundEnabled: true,
        syncing: false,
        retryLocalPaths: [],
        stillDeferred: () => false,
      }),
    ).toBe(false);
    expect(
      shouldFlushDeferredApplies({
        backgroundEnabled: true,
        syncing: false,
        retryLocalPaths: ["open.md"],
        stillDeferred: () => true,
      }),
    ).toBe(false);
    expect(
      shouldFlushDeferredApplies({
        backgroundEnabled: true,
        syncing: true,
        retryLocalPaths: ["open.md"],
        stillDeferred: () => false,
      }),
    ).toBe(false);
    expect(
      shouldFlushDeferredApplies({
        backgroundEnabled: false,
        syncing: false,
        retryLocalPaths: ["open.md"],
        stillDeferred: () => false,
      }),
    ).toBe(false);
  });

  test("mixed retries: flush when at least one path is unlocked", () => {
    expect(
      shouldFlushDeferredApplies({
        backgroundEnabled: true,
        syncing: false,
        retryLocalPaths: ["still-open.md", "left.md"],
        stillDeferred: (path) => path === "still-open.md",
      }),
    ).toBe(true);
  });
});
