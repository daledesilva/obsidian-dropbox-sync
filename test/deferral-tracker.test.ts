import { describe, expect, test } from "bun:test";
import {
  ACTIVE_FILE_DEFERRAL_MS,
  DeferralTracker,
} from "@/sync/deferral-tracker";

describe("DeferralTracker", () => {
  test("first markDeferred sticks; remount does not reset the clock", () => {
    const tracker = new DeferralTracker(60_000);
    tracker.markDeferred("note.md", 1_000);
    tracker.markDeferred("note.md", 5_000);
    expect(tracker.elapsedMs("note.md", 5_000)).toBe(4_000);
    expect(tracker.isWithinBound("note.md", 5_000)).toBe(true);
  });

  test("within bound then expired", () => {
    const tracker = new DeferralTracker(1_000);
    tracker.markDeferred("note.md", 0);
    expect(tracker.boundExpired("note.md", 999)).toBe(false);
    expect(tracker.boundExpired("note.md", 1_000)).toBe(true);
  });

  test("minRemainingMs returns soonest remaining across paths", () => {
    const tracker = new DeferralTracker(10_000);
    tracker.markDeferred("a.md", 0);
    tracker.markDeferred("b.md", 4_000);
    expect(tracker.minRemainingMs(5_000)).toBe(5_000);
    expect(tracker.minRemainingMs(10_000)).toBe(0);
  });

  test("clear removes path; empty tracker has no minRemaining", () => {
    const tracker = new DeferralTracker();
    tracker.markDeferred("note.md", 0);
    tracker.clear("note.md");
    expect(tracker.elapsedMs("note.md", 100)).toBeUndefined();
    expect(tracker.minRemainingMs(100)).toBeUndefined();
    expect(tracker.isWithinBound("note.md", 100)).toBe(true);
  });

  test("default bound matches G10 ACTIVE_FILE_DEFERRAL_MS", () => {
    expect(ACTIVE_FILE_DEFERRAL_MS).toBe(60_000);
    const tracker = new DeferralTracker();
    tracker.markDeferred("note.md", 0);
    expect(tracker.boundExpired("note.md", 59_999)).toBe(false);
    expect(tracker.boundExpired("note.md", 60_000)).toBe(true);
  });
});
