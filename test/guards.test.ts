import { describe, test, expect } from "bun:test";
import { checkDeleteGuard } from "@/sync/guards";
import type { SyncPlan, SyncPlanItem } from "@/types"
import { emptySyncPlanStats } from "@/types";

function mkPlan(...items: SyncPlanItem[]): SyncPlan {
  const stats = emptySyncPlanStats();
  for (const item of items) {
    const key = item.action.type;
    if (key in stats) (stats as Record<string, number>)[key]++;
  }
  return { items, stats };
}

const mkItem = (path: string, type: string, reason = ""): SyncPlanItem => ({
  pathLower: path.toLowerCase(),
  localPath: path,
  action: type === "conflict"
    ? { type: "conflict", localHash: "a", remoteHash: "b" }
    : { type: type as "upload", reason },
});

describe("checkDeleteGuard", () => {
  test("삭제 개수 ≤ threshold → 통과", () => {
    const plan = mkPlan(
      mkItem("a.md", "deleteRemote", "deleted_on_local"),
      mkItem("b.md", "deleteRemote", "deleted_on_local"),
      mkItem("c.md", "upload", "new_local"),
    );
    const result = checkDeleteGuard(plan, 5);
    expect(result.passed).toBe(true);
    expect(result.filteredPlan).toBe(plan); // 원본 그대로
  });

  test("삭제 개수 > threshold → 차단", () => {
    const plan = mkPlan(
      mkItem("a.md", "deleteRemote", "deleted_on_local"),
      mkItem("b.md", "deleteRemote", "deleted_on_local"),
      mkItem("c.md", "deleteLocal", "deleted_on_remote"),
      mkItem("d.md", "upload", "new_local"),
    );
    const result = checkDeleteGuard(plan, 2);
    expect(result.passed).toBe(false);
    expect(result.deleteItems).toHaveLength(3);
    expect(result.filteredPlan.items).toHaveLength(1);
    expect(result.filteredPlan.items[0].localPath).toBe("d.md");
    expect(result.filteredPlan.stats.deleteRemote).toBe(0);
    expect(result.filteredPlan.stats.deleteLocal).toBe(0);
  });

  test("비활성화 → 항상 통과", () => {
    const plan = mkPlan(
      mkItem("a.md", "deleteRemote", "deleted_on_local"),
      mkItem("b.md", "deleteRemote", "deleted_on_local"),
      mkItem("c.md", "deleteRemote", "deleted_on_local"),
      mkItem("d.md", "deleteRemote", "deleted_on_local"),
      mkItem("e.md", "deleteRemote", "deleted_on_local"),
      mkItem("f.md", "deleteRemote", "deleted_on_local"),
    );
    const result = checkDeleteGuard(plan, 2, false);
    expect(result.passed).toBe(true);
    expect(result.filteredPlan).toBe(plan);
  });

  test("삭제 없는 플랜 → 통과", () => {
    const plan = mkPlan(
      mkItem("a.md", "upload", "new_local"),
      mkItem("b.md", "download", "new_remote"),
    );
    const result = checkDeleteGuard(plan, 5);
    expect(result.passed).toBe(true);
  });

  test("정확히 threshold 개수 → 통과", () => {
    const plan = mkPlan(
      mkItem("a.md", "deleteRemote", "deleted_on_local"),
      mkItem("b.md", "deleteRemote", "deleted_on_local"),
      mkItem("c.md", "deleteRemote", "deleted_on_local"),
    );
    const result = checkDeleteGuard(plan, 3);
    expect(result.passed).toBe(true);
  });

  test("threshold=0 → 삭제 1개라도 차단", () => {
    const plan = mkPlan(
      mkItem("a.md", "deleteRemote", "deleted_on_local"),
    );
    const result = checkDeleteGuard(plan, 0);
    expect(result.passed).toBe(false);
    expect(result.deleteItems).toHaveLength(1);
  });

  test("deleteLocal과 deleteRemote 모두 카운트", () => {
    const plan = mkPlan(
      mkItem("a.md", "deleteRemote", "deleted_on_local"),
      mkItem("b.md", "deleteLocal", "deleted_on_remote"),
    );
    const result = checkDeleteGuard(plan, 1);
    expect(result.passed).toBe(false);
    expect(result.deleteItems).toHaveLength(2);
  });
});
