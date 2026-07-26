import { describe, test, expect } from "bun:test";
import {
  classifyPermanentFailure,
  filterPermanentSkippedItems,
  mergePermanentSkipAfterCycle,
  PermanentSyncFailureError,
} from "@/sync/permanent-skip";
import type { SyncPlanItem, SyncResult } from "@/types";

describe("permanent skip (G17)", () => {
  test("classifies ENOSPC and disk full", () => {
    expect(classifyPermanentFailure(new Error("write failed: ENOSPC"))).toBe("disk_full");
    expect(classifyPermanentFailure(new PermanentSyncFailureError("disk full", "disk_full"))).toBe(
      "disk_full",
    );
  });

  test("classifies oversized payloads", () => {
    expect(classifyPermanentFailure(new Error("entity too large for device"))).toBe("oversized");
  });

  test("mergePermanentSkipAfterCycle retains permanent failures", () => {
    const item: SyncPlanItem = {
      pathLower: "big.bin",
      localPath: "big.bin",
      action: { type: "download", reason: "new_remote" },
    };
    const result: SyncResult = {
      succeeded: [],
      failed: [
        {
          item,
          error: new PermanentSyncFailureError("Disk full", "disk_full"),
        },
      ],
      deferred: [],
    };
    const next = mergePermanentSkipAfterCycle([], result, 1);
    expect(next).toHaveLength(1);
    expect(next[0]!.pathLower).toBe("big.bin");
    expect(next[0]!.kind).toBe("disk_full");
  });

  test("filterPermanentSkippedItems removes skipped paths from plan", () => {
    const items: SyncPlanItem[] = [
      { pathLower: "a.md", localPath: "a.md", action: { type: "download", reason: "new_remote" } },
      { pathLower: "b.md", localPath: "b.md", action: { type: "upload", reason: "local_modified" } },
    ];
    const filtered = filterPermanentSkippedItems(items, [
      {
        pathLower: "a.md",
        localPath: "a.md",
        kind: "disk_full",
        errorMessage: "full",
        addedAt: 1,
      },
    ]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.localPath).toBe("b.md");
  });
});
