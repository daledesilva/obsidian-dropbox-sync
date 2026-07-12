import { describe, test, expect } from "bun:test";
import { buildSyncSummaryMarkdown, type SyncReportInput } from "@/ui/sync-feedback";

describe("live report finalize", () => {
  test("summary section includes outcome", () => {
    const input: SyncReportInput = {
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_010_000,
      outcome: "up_to_date",
      deviceId: "test-device",
      version: "0.0.0",
      plan: {
        items: [],
        stats: { upload: 0, download: 0, deleteLocal: 0, deleteRemote: 0, conflict: 0, noop: 0 },
      },
      result: { succeeded: [], failed: [], deferred: [] },
    };
    const md = buildSyncSummaryMarkdown(input);
    expect(md).toContain("Up to date");
    expect(md).toContain("10.0s");
  });
});
