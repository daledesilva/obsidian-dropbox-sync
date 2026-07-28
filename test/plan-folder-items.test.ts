import { describe, expect, test } from "bun:test";
import { enhanceSyncPlan } from "@/sync/plan-enhancements";
import type { FileInfo, FolderInfo, RemoteEntry, SyncEntry, SyncPlanItem } from "@/types";
import { emptySyncPlanStats } from "@/types";

function mkFile(path: string): FileInfo {
  return {
    path,
    pathLower: path.toLowerCase(),
    hash: "h",
    mtime: 1,
    size: 1,
  };
}

function mkFolder(path: string): FolderInfo {
  return { path, pathLower: path.toLowerCase() };
}

function mkRemoteFolder(path: string): RemoteEntry {
  return {
    pathLower: path.toLowerCase(),
    pathDisplay: path,
    hash: null,
    rev: null,
    serverModified: 0,
    size: 0,
    deleted: false,
    isFolder: true,
  };
}

function mkFolderBase(path: string): SyncEntry {
  return {
    pathLower: path.toLowerCase(),
    localPath: path,
    baseLocalHash: null,
    baseRemoteHash: null,
    rev: null,
    lastSynced: 1,
    entryKind: "folder",
  };
}

function emptyPlan(items: SyncPlanItem[] = []) {
  const stats = emptySyncPlanStats();
  for (const item of items) {
    const key = item.action.type;
    if (key in stats) (stats as Record<string, number>)[key]++;
  }
  return { items, stats };
}

describe("enhanceSyncPlan folder wipe rules", () => {
  test("local tree gone + base folder → inferred deleteRemoteFolder", () => {
    const plan = enhanceSyncPlan(emptyPlan(), {
      localFiles: [],
      localFolders: [],
      remoteEntries: [mkRemoteFolder("tree")],
      baseEntries: [mkFolderBase("tree")],
    });
    const folderDelete = plan.items.find((i) => i.pathLower === "tree");
    expect(folderDelete?.action.type).toBe("deleteRemoteFolder");
    expect(folderDelete?.action).toMatchObject({
      type: "deleteRemoteFolder",
      reason: "inferred_local_tree_wipe",
    });
  });

  test("remote folder gone + all children planned deleteLocal → deleteLocalFolder same cycle", () => {
    const basePlan = emptyPlan([
      {
        pathLower: "tree/a.md",
        localPath: "tree/a.md",
        action: { type: "deleteLocal", reason: "deleted_on_remote" },
      },
      {
        pathLower: "tree/b.md",
        localPath: "tree/b.md",
        action: { type: "deleteLocal", reason: "deleted_on_remote" },
      },
    ]);
    const plan = enhanceSyncPlan(basePlan, {
      localFiles: [mkFile("tree/a.md"), mkFile("tree/b.md")],
      localFolders: [mkFolder("tree")],
      remoteEntries: [],
      baseEntries: [
        mkFolderBase("tree"),
        {
          pathLower: "tree/a.md",
          localPath: "tree/a.md",
          baseLocalHash: "h",
          baseRemoteHash: "h",
          rev: "r1",
          lastSynced: 1,
        },
        {
          pathLower: "tree/b.md",
          localPath: "tree/b.md",
          baseLocalHash: "h",
          baseRemoteHash: "h",
          rev: "r2",
          lastSynced: 1,
        },
      ],
    });
    expect(plan.items.some((i) =>
      i.pathLower === "tree" && i.action.type === "deleteLocalFolder"
    )).toBe(true);
  });

  test("remote folder gone + unmanaged local child → no deleteLocalFolder", () => {
    const basePlan = emptyPlan([
      {
        pathLower: "tree/tracked.md",
        localPath: "tree/tracked.md",
        action: { type: "deleteLocal", reason: "deleted_on_remote" },
      },
    ]);
    const plan = enhanceSyncPlan(basePlan, {
      localFiles: [mkFile("tree/tracked.md"), mkFile("tree/unmanaged.md")],
      localFolders: [mkFolder("tree")],
      remoteEntries: [],
      baseEntries: [mkFolderBase("tree")],
    });
    expect(plan.items.some((i) => i.action.type === "deleteLocalFolder")).toBe(false);
  });

  test("children gone locally but empty folder remains → no deleteRemoteFolder", () => {
    const plan = enhanceSyncPlan(emptyPlan(), {
      localFiles: [],
      localFolders: [mkFolder("bulk")],
      remoteEntries: [
        mkRemoteFolder("bulk"),
        {
          pathLower: "bulk/a.md",
          pathDisplay: "bulk/a.md",
          hash: "h",
          rev: "r",
          serverModified: 0,
          size: 1,
          deleted: false,
        },
      ],
      baseEntries: [
        mkFolderBase("bulk"),
        {
          pathLower: "bulk/a.md",
          localPath: "bulk/a.md",
          baseLocalHash: "h",
          baseRemoteHash: "h",
          rev: "r",
          lastSynced: 1,
        },
      ],
      localDeletedPaths: new Set(["bulk/a.md"]),
    });
    expect(plan.items.some((i) =>
      i.pathLower === "bulk" && i.action.type === "deleteRemoteFolder"
    )).toBe(false);
  });
});
