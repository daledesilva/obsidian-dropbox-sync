import { describe, test, expect } from "bun:test";
import { checkPathGuard } from "@/sync/path-guard";
import type { SyncPlan, SyncPlanItem } from "@/types";

function item(localPath: string, action: SyncPlanItem["action"]): SyncPlanItem {
  return { pathLower: localPath.toLowerCase(), localPath, action };
}

function plan(...items: SyncPlanItem[]): SyncPlan {
  return {
    items,
    stats: { upload: 0, download: 0, deleteLocal: 0, deleteRemote: 0, conflict: 0, noop: 0 },
  };
}

describe("checkPathGuard", () => {
  test("compatible paths → passed", () => {
    const p = plan(item("ok.md", { type: "download", reason: "remote newer" }));
    const r = checkPathGuard(p, true);
    expect(r.passed).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  test("incompatible download → blocked with suggestion", () => {
    const p = plan(item("bad:name.md", { type: "download", reason: "remote newer" }));
    const r = checkPathGuard(p, true);
    expect(r.passed).toBe(false);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0].suggestedPath).toBe("bad-name.md");
    expect(r.filteredPlan.items).toHaveLength(0);
  });

  test("noop items are not checked", () => {
    const p = plan(item("bad:name.md", { type: "noop", reason: "same" }));
    const r = checkPathGuard(p, true);
    expect(r.passed).toBe(true);
  });
});
