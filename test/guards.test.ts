import { describe, test, expect } from "bun:test";
import {
  checkDeleteGuard,
  deleteGuardEffectiveCount,
  isDeletePlanAction,
  splitPlanDeletes,
} from "@/sync/guards";
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

describe("isDeletePlanAction / splitPlanDeletes", () => {
  test("file and folder delete actions are delete-plan actions", () => {
    expect(isDeletePlanAction("deleteRemote")).toBe(true);
    expect(isDeletePlanAction("deleteLocal")).toBe(true);
    expect(isDeletePlanAction("deleteRemoteFolder")).toBe(true);
    expect(isDeletePlanAction("deleteLocalFolder")).toBe(true);
    expect(isDeletePlanAction("upload")).toBe(false);
  });

  test("splitPlanDeletes peels file and folder deletes from non-delete work", () => {
    const plan = mkPlan(
      mkItem("keep.md", "upload", "new_local"),
      mkItem("gone.md", "deleteRemote", "deleted_on_local"),
      mkItem("tree", "deleteRemoteFolder", "inferred_local_tree_wipe"),
    );
    const { deleteItems, nonDeletePlan } = splitPlanDeletes(plan);
    expect(deleteItems.map((i) => i.action.type).sort()).toEqual([
      "deleteRemote",
      "deleteRemoteFolder",
    ]);
    expect(nonDeletePlan.items).toHaveLength(1);
    expect(nonDeletePlan.items[0].localPath).toBe("keep.md");
    expect(nonDeletePlan.stats.deleteRemote).toBe(0);
    expect(nonDeletePlan.stats.deleteRemoteFolder).toBe(0);
  });

  test("splitPlanDeletes peels deleteLocalFolder", () => {
    const plan = mkPlan(
      mkItem("a.md", "deleteLocal", "deleted_on_remote"),
      mkItem("folder", "deleteLocalFolder", "deleted_on_remote"),
      mkItem("b.md", "download", "new_remote"),
    );
    const { deleteItems, nonDeletePlan } = splitPlanDeletes(plan);
    expect(deleteItems).toHaveLength(2);
    expect(nonDeletePlan.items.map((i) => i.localPath)).toEqual(["b.md"]);
  });
});

describe("deleteGuardEffectiveCount / folder R9 weight", () => {
  test("one deleteRemoteFolder alone exceeds a file-count threshold", () => {
    const deletes = [mkItem("tree", "deleteRemoteFolder", "inferred_local_tree_wipe")];
    expect(deleteGuardEffectiveCount(deletes, 5)).toBe(6);
    const result = checkDeleteGuard(mkPlan(...deletes), 5);
    expect(result.passed).toBe(false);
    expect(result.deleteItems).toHaveLength(1);
  });

  test("one deleteLocalFolder alone exceeds threshold", () => {
    const deletes = [mkItem("tree", "deleteLocalFolder", "deleted_on_remote")];
    expect(deleteGuardEffectiveCount(deletes, 5)).toBe(6);
    expect(checkDeleteGuard(mkPlan(...deletes), 5).passed).toBe(false);
  });

  test("two file deletes under threshold pass; adding a folder delete fails", () => {
    const filesOnly = mkPlan(
      mkItem("a.md", "deleteRemote", "deleted_on_local"),
      mkItem("b.md", "deleteRemote", "deleted_on_local"),
    );
    expect(checkDeleteGuard(filesOnly, 5).passed).toBe(true);

    const withFolder = mkPlan(
      mkItem("a.md", "deleteRemote", "deleted_on_local"),
      mkItem("b.md", "deleteRemote", "deleted_on_local"),
      mkItem("tree", "deleteRemoteFolder", "inferred_local_tree_wipe"),
    );
    expect(checkDeleteGuard(withFolder, 5).passed).toBe(false);
    expect(checkDeleteGuard(withFolder, 5).deleteItems).toHaveLength(3);
  });
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
