import { describe, test, expect } from "bun:test";
import {
  buildSyncLogPath,
  buildSyncSummaryMarkdown,
  buildSyncResultFeedback,
  type SyncReportInput,
} from "@/ui/sync-feedback";
import type { SyncPlan, SyncResult } from "@/types";

function makeResult(overrides: Partial<SyncResult> = {}): SyncResult {
  return {
    succeeded: [],
    failed: [],
    deferred: [],
    ...overrides,
  };
}

function makePlan(stats: Partial<SyncPlan["stats"]> = {}): SyncPlan {
  return {
    items: [],
    stats: {
      upload: 0,
      download: 0,
      deleteLocal: 0,
      deleteRemote: 0,
      conflict: 0,
      noop: 0,
      ...stats,
    },
  };
}

describe("buildSyncResultFeedback", () => {
  test("up to date when nothing changed", () => {
    const fb = buildSyncResultFeedback(makeResult());
    expect(fb.outcome).toBe("up_to_date");
    expect(fb.summary).toBe("up to date");
  });

  test("success when items succeeded", () => {
    const fb = buildSyncResultFeedback(
      makeResult({
        succeeded: [
          { pathLower: "a.md", localPath: "a.md", action: { type: "upload", reason: "local newer" } },
        ],
      }),
    );
    expect(fb.outcome).toBe("success");
    expect(fb.endMessage).toContain("Dropbox Sync:");
  });
});

describe("buildSyncLogPath", () => {
  test("returns timestamped path with device type and id under sync-logs/", () => {
    const startedAt = new Date("2025-05-24T14:30:52").getTime();
    expect(buildSyncLogPath(startedAt, "abcd", "desktop")).toBe(
      "sync-logs/_sync-log_2025-05-24-143052_desktop_abcd.md",
    );
  });
});

describe("buildSyncSummaryMarkdown", () => {
  test("renders header, stats, and succeeded list", () => {
    const input: SyncReportInput = {
      startedAt: 1_000,
      endedAt: 2_500,
      outcome: "success",
      plan: makePlan({ upload: 2, download: 1 }),
      result: makeResult({
        succeeded: [
          { pathLower: "note.md", localPath: "note.md", action: { type: "upload", reason: "local newer" } },
        ],
      }),
      deviceId: "abcd",
      version: "1.0.2",
    };

    const md = buildSyncSummaryMarkdown(input);
    expect(md).toContain("# Dropbox Sync —");
    expect(md).toContain("**Status:** Success");
    expect(md).toContain("**Duration:** 1.5s");
    expect(md).toContain("## Plan stats");
    expect(md).toContain("| upload | 2 |");
    expect(md).toContain("## Succeeded");
    expect(md).toContain("`note.md`");
  });

  test("renders failed section", () => {
    const input: SyncReportInput = {
      startedAt: 0,
      endedAt: 1000,
      outcome: "failed",
      result: makeResult({
        failed: [
          {
            item: { pathLower: "bad.md", localPath: "bad.md", action: { type: "download", reason: "r" } },
            error: new Error("network timeout"),
          },
        ],
      }),
      deviceId: "x",
      version: "1.0.0",
    };

    const md = buildSyncSummaryMarkdown(input);
    expect(md).toContain("**Status:** Failed");
    expect(md).toContain("## Failed");
    expect(md).toContain("network timeout");
  });
});
