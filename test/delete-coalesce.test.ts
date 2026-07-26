import { describe, expect, test } from "bun:test";
import { coalesceDeleteRemote, unionPathLowers } from "@/sync/delete-coalesce";
import type { SyncPlanItem } from "@/types";

function deleteItem(path: string): SyncPlanItem {
  return {
    pathLower: path.toLowerCase(),
    localPath: path,
    action: { type: "deleteRemote", reason: "deleted_on_local" },
  };
}

describe("coalesceDeleteRemote", () => {
  test("complete folder coalesces when all remote files under it are deleted", () => {
    const items = [
      deleteItem("notes/a.md"),
      deleteItem("notes/b.md"),
      deleteItem("notes/c.md"),
    ];
    const result = coalesceDeleteRemote({
      deleteRemoteItems: items,
      existingRemotePathLowers: ["notes/a.md", "notes/b.md", "notes/c.md"],
      blockingPathLowers: [],
    });

    expect(result.folderPaths).toEqual(["notes"]);
    expect(result.remainingFileItems).toEqual([]);
    expect(result.folderToCoveredItems.get("notes")?.map((i) => i.pathLower).sort()).toEqual([
      "notes/a.md",
      "notes/b.md",
      "notes/c.md",
    ]);
  });

  test("nested maximal pick prefers the shallowest complete ancestor", () => {
    const items = [
      deleteItem("proj/src/a.ts"),
      deleteItem("proj/src/b.ts"),
      deleteItem("proj/readme.md"),
    ];
    const result = coalesceDeleteRemote({
      deleteRemoteItems: items,
      existingRemotePathLowers: items.map((i) => i.pathLower),
      blockingPathLowers: [],
    });

    // All three under proj → one folder delete, not proj/src + readme.
    expect(result.folderPaths).toEqual(["proj"]);
    expect(result.remainingFileItems).toEqual([]);
    expect(result.folderToCoveredItems.has("proj/src")).toBe(false);
  });

  test("blocker path under folder prevents coalesce", () => {
    const items = [deleteItem("notes/a.md"), deleteItem("notes/b.md")];
    const result = coalesceDeleteRemote({
      deleteRemoteItems: items,
      existingRemotePathLowers: ["notes/a.md", "notes/b.md"],
      blockingPathLowers: ["notes/keep.md"],
    });

    expect(result.folderPaths).toEqual([]);
    expect(result.remainingFileItems.map((i) => i.pathLower).sort()).toEqual([
      "notes/a.md",
      "notes/b.md",
    ]);
  });

  test("partial subtree does not coalesce when a remote sibling remains", () => {
    const items = [deleteItem("notes/a.md"), deleteItem("notes/b.md")];
    const result = coalesceDeleteRemote({
      deleteRemoteItems: items,
      existingRemotePathLowers: ["notes/a.md", "notes/b.md", "notes/keep.md"],
      blockingPathLowers: [],
    });

    expect(result.folderPaths).toEqual([]);
    expect(result.remainingFileItems).toHaveLength(2);
  });

  test("min cover size 2 — single-file folder stays as file delete", () => {
    const items = [deleteItem("notes/only.md")];
    const result = coalesceDeleteRemote({
      deleteRemoteItems: items,
      existingRemotePathLowers: ["notes/only.md"],
      blockingPathLowers: [],
    });

    expect(result.folderPaths).toEqual([]);
    expect(result.remainingFileItems).toEqual(items);
  });

  test("does not emit empty or root folder paths", () => {
    const items = [deleteItem("a.md"), deleteItem("b.md")];
    const result = coalesceDeleteRemote({
      deleteRemoteItems: items,
      existingRemotePathLowers: ["a.md", "b.md"],
      blockingPathLowers: [],
    });

    // Vault-root siblings share no non-empty parent folder candidate.
    expect(result.folderPaths).toEqual([]);
    expect(result.remainingFileItems).toHaveLength(2);
  });

  test("inner folder coalesce when parent has a kept sibling", () => {
    const items = [
      deleteItem("notes/old/a.md"),
      deleteItem("notes/old/b.md"),
      deleteItem("notes/keep.md"), // not under old/
    ];
    // keep.md is also being deleted but sits beside old/ — parent notes/ is incomplete
    // because existing remote still has notes/other.md.
    const result = coalesceDeleteRemote({
      deleteRemoteItems: items,
      existingRemotePathLowers: [
        "notes/old/a.md",
        "notes/old/b.md",
        "notes/keep.md",
        "notes/other.md",
      ],
      blockingPathLowers: [],
    });

    expect(result.folderPaths).toEqual(["notes/old"]);
    expect(result.remainingFileItems.map((i) => i.pathLower)).toEqual(["notes/keep.md"]);
  });

  test("empty existingRemote refuses all folder coalesce", () => {
    const items = [
      deleteItem("notes/a.md"),
      deleteItem("notes/b.md"),
      deleteItem("notes/c.md"),
    ];
    const result = coalesceDeleteRemote({
      deleteRemoteItems: items,
      existingRemotePathLowers: [],
      blockingPathLowers: [],
    });

    expect(result.folderPaths).toEqual([]);
    expect(result.remainingFileItems).toHaveLength(3);
  });
});

describe("unionPathLowers", () => {
  test("keeps prior notes remotes when a later section adds nothing", () => {
    const afterNotes = unionPathLowers([], ["notes/a.md", "notes/b.md"]);
    const afterSettings = unionPathLowers(afterNotes, []);
    expect(afterSettings.sort()).toEqual(["notes/a.md", "notes/b.md"]);
  });

  test("unions distinct section paths", () => {
    const merged = unionPathLowers(
      ["notes/a.md"],
      [".obsidian/app.json", "Notes/A.md"],
    );
    expect(merged.sort()).toEqual([".obsidian/app.json", "notes/a.md"]);
  });
});
