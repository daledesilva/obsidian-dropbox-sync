import { describe, test, expect } from "bun:test";
import { buildPathNotice } from "@/sync/path-notices";
import type { SyncPlanItem } from "@/types";

describe("path notices (G13)", () => {
  test("explains resurrection upload", () => {
    const item: SyncPlanItem = {
      pathLower: "note.md",
      localPath: "note.md",
      action: { type: "upload", reason: "local_modified_remote_deleted" },
    };
    const message = buildPathNotice(item);
    expect(message).toContain("restored");
    expect(message).toContain("note.md");
  });

  test("explains case adoption on download", () => {
    const item: SyncPlanItem = {
      pathLower: "note.md",
      localPath: "note.md",
      action: { type: "download", reason: "remote_modified" },
    };
    const message = buildPathNotice(item, { remotePathDisplay: "Note.md" });
    expect(message).toContain("capitalisation");
  });
});
