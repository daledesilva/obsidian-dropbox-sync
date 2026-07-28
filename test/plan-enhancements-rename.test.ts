import { describe, expect, test } from "bun:test";
import { enhanceSyncPlan } from "@/sync/plan-enhancements";
import type { FileInfo, FolderInfo, RemoteEntry, SyncEntry, SyncPlanItem } from "@/types";
import { emptySyncPlanStats } from "@/types";

function mkFile(path: string, hash = "h1"): FileInfo {
  return {
    path,
    pathLower: path.toLowerCase(),
    hash,
    mtime: 1,
    size: 1,
  };
}

function mkFolder(path: string): FolderInfo {
  return { path, pathLower: path.toLowerCase() };
}

function mkRemoteFile(path: string, hash = "h1"): RemoteEntry {
  return {
    pathLower: path.toLowerCase(),
    pathDisplay: path,
    hash,
    rev: "r1",
    serverModified: 0,
    size: 1,
    deleted: false,
    isFolder: false,
  };
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

function mkFileBase(path: string, hash = "h1"): SyncEntry {
  return {
    pathLower: path.toLowerCase(),
    localPath: path,
    baseLocalHash: hash,
    baseRemoteHash: hash,
    rev: "r1",
    lastSynced: 1,
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

function actionsOf(plan: { items: SyncPlanItem[] }, type: string): SyncPlanItem[] {
  return plan.items.filter((i) => i.action.type === type);
}

describe("enhanceSyncPlan G7 file content renames", () => {
  test("local rename (same parent) → moveRemote, not upload+deleteRemote", () => {
    const basePlan = emptyPlan([
      {
        pathLower: "notes/renamed.md",
        localPath: "notes/renamed.md",
        action: { type: "upload", reason: "new_local" },
      },
      {
        pathLower: "notes/rename-me.md",
        localPath: "notes/rename-me.md",
        action: { type: "deleteRemote", reason: "deleted_on_local" },
      },
    ]);
    const plan = enhanceSyncPlan(basePlan, {
      localFiles: [mkFile("notes/renamed.md", "abc")],
      localFolders: [mkFolder("notes")],
      remoteEntries: [
        mkRemoteFolder("notes"),
        mkRemoteFile("notes/rename-me.md", "abc"),
      ],
      baseEntries: [
        mkFolderBase("notes"),
        mkFileBase("notes/rename-me.md", "abc"),
      ],
    });

    const moves = actionsOf(plan, "moveRemote");
    expect(moves).toHaveLength(1);
    expect(moves[0]!.action).toMatchObject({
      type: "moveRemote",
      fromPath: "notes/rename-me.md",
      toPath: "notes/renamed.md",
      reason: "content_rename_detected",
    });
    expect(actionsOf(plan, "upload")).toHaveLength(0);
    expect(actionsOf(plan, "deleteRemote")).toHaveLength(0);
  });

  test("local move (cross directory) → moveRemote", () => {
    const basePlan = emptyPlan([
      {
        pathLower: "folders/a.md",
        localPath: "folders/a.md",
        action: { type: "upload", reason: "new_local" },
      },
      {
        pathLower: "folders/nested/a.md",
        localPath: "folders/nested/a.md",
        action: { type: "deleteRemote", reason: "deleted_on_local" },
      },
    ]);
    const plan = enhanceSyncPlan(basePlan, {
      localFiles: [mkFile("folders/a.md", "deep")],
      localFolders: [mkFolder("folders"), mkFolder("folders/nested")],
      remoteEntries: [
        mkRemoteFolder("folders"),
        mkRemoteFolder("folders/nested"),
        mkRemoteFile("folders/nested/a.md", "deep"),
      ],
      baseEntries: [
        mkFolderBase("folders"),
        mkFolderBase("folders/nested"),
        mkFileBase("folders/nested/a.md", "deep"),
      ],
    });

    const moves = actionsOf(plan, "moveRemote");
    expect(moves).toHaveLength(1);
    expect(moves[0]!.action).toMatchObject({
      type: "moveRemote",
      fromPath: "folders/nested/a.md",
      toPath: "folders/a.md",
      reason: "content_rename_detected",
    });
  });

  test("remote rename (peer) → moveLocal", () => {
    const basePlan = emptyPlan([
      {
        pathLower: "notes/old.md",
        localPath: "notes/old.md",
        action: { type: "deleteLocal", reason: "deleted_on_remote" },
      },
      {
        pathLower: "notes/new.md",
        localPath: "notes/new.md",
        action: { type: "download", reason: "new_remote" },
      },
    ]);
    const plan = enhanceSyncPlan(basePlan, {
      localFiles: [mkFile("notes/old.md", "peer")],
      localFolders: [mkFolder("notes")],
      remoteEntries: [
        mkRemoteFolder("notes"),
        mkRemoteFile("notes/new.md", "peer"),
      ],
      baseEntries: [
        mkFolderBase("notes"),
        mkFileBase("notes/old.md", "peer"),
      ],
    });

    const moves = actionsOf(plan, "moveLocal");
    expect(moves).toHaveLength(1);
    expect(moves[0]!.action).toMatchObject({
      type: "moveLocal",
      fromPath: "notes/old.md",
      toPath: "notes/new.md",
      reason: "content_rename_detected",
    });
    expect(actionsOf(plan, "deleteLocal")).toHaveLength(0);
    expect(actionsOf(plan, "download")).toHaveLength(0);
  });

  test("ambiguous same-hash locals → no moveRemote for vanished base", () => {
    const basePlan = emptyPlan([
      {
        pathLower: "notes/a.md",
        localPath: "notes/a.md",
        action: { type: "upload", reason: "new_local" },
      },
      {
        pathLower: "notes/b.md",
        localPath: "notes/b.md",
        action: { type: "upload", reason: "new_local" },
      },
      {
        pathLower: "notes/gone.md",
        localPath: "notes/gone.md",
        action: { type: "deleteRemote", reason: "deleted_on_local" },
      },
    ]);
    const plan = enhanceSyncPlan(basePlan, {
      localFiles: [mkFile("notes/a.md", "same"), mkFile("notes/b.md", "same")],
      localFolders: [mkFolder("notes")],
      remoteEntries: [
        mkRemoteFolder("notes"),
        mkRemoteFile("notes/gone.md", "same"),
      ],
      baseEntries: [
        mkFolderBase("notes"),
        mkFileBase("notes/gone.md", "same"),
      ],
    });

    expect(actionsOf(plan, "moveRemote")).toHaveLength(0);
    expect(actionsOf(plan, "upload").length).toBeGreaterThanOrEqual(1);
    expect(actionsOf(plan, "deleteRemote").some((i) => i.pathLower === "notes/gone.md")).toBe(true);
  });
});

describe("enhanceSyncPlan G8 folder renames / moves", () => {
  test("local folder rename (populated) → moveRemoteFolder, suppresses create/delete/file moves", () => {
    const basePlan = emptyPlan([
      {
        pathLower: "notes-renamed/a.md",
        localPath: "notes-renamed/a.md",
        action: { type: "upload", reason: "new_local" },
      },
      {
        pathLower: "notes/a.md",
        localPath: "notes/a.md",
        action: { type: "deleteRemote", reason: "deleted_on_local" },
      },
    ]);
    const plan = enhanceSyncPlan(basePlan, {
      localFiles: [mkFile("notes-renamed/a.md", "n1")],
      localFolders: [
        mkFolder("notes-renamed"),
        mkFolder("notes-renamed/empty"),
      ],
      remoteEntries: [
        mkRemoteFolder("notes"),
        mkRemoteFolder("notes/empty"),
        mkRemoteFile("notes/a.md", "n1"),
      ],
      baseEntries: [
        mkFolderBase("notes"),
        mkFolderBase("notes/empty"),
        mkFileBase("notes/a.md", "n1"),
      ],
    });

    const folderMoves = actionsOf(plan, "moveRemoteFolder");
    expect(folderMoves).toHaveLength(1);
    expect(folderMoves[0]!.action).toMatchObject({
      type: "moveRemoteFolder",
      fromPath: "notes",
      toPath: "notes-renamed",
      reason: "folder_rename_detected",
    });
    expect(actionsOf(plan, "createRemoteFolder")).toHaveLength(0);
    expect(actionsOf(plan, "deleteRemoteFolder")).toHaveLength(0);
    expect(actionsOf(plan, "moveRemote")).toHaveLength(0);
    expect(actionsOf(plan, "upload")).toHaveLength(0);
    expect(actionsOf(plan, "deleteRemote")).toHaveLength(0);
  });

  test("local folder move (cross parent) → moveRemoteFolder", () => {
    const plan = enhanceSyncPlan(emptyPlan(), {
      localFiles: [mkFile("case/folders/nested/deep.md", "d1")],
      localFolders: [
        mkFolder("case"),
        mkFolder("case/folders"),
        mkFolder("case/folders/empty-keep"),
        mkFolder("case/folders/nested"),
      ],
      remoteEntries: [
        mkRemoteFolder("folders"),
        mkRemoteFolder("folders/empty-keep"),
        mkRemoteFolder("folders/nested"),
        mkRemoteFile("folders/nested/deep.md", "d1"),
      ],
      baseEntries: [
        mkFolderBase("folders"),
        mkFolderBase("folders/empty-keep"),
        mkFolderBase("folders/nested"),
        mkFileBase("folders/nested/deep.md", "d1"),
      ],
    });

    const folderMoves = actionsOf(plan, "moveRemoteFolder");
    expect(folderMoves).toHaveLength(1);
    expect(folderMoves[0]!.action).toMatchObject({
      type: "moveRemoteFolder",
      fromPath: "folders",
      toPath: "case/folders",
    });
    expect(actionsOf(plan, "deleteRemoteFolder")).toHaveLength(0);
    expect(actionsOf(plan, "createRemoteFolder").every(
      (i) => !i.pathLower.startsWith("case/folders"),
    )).toBe(true);
  });

  test("remote folder rename (peer) → moveLocalFolder, no file move pile or empty delete", () => {
    const basePlan = emptyPlan([
      {
        pathLower: "notes/a.md",
        localPath: "notes/a.md",
        action: { type: "deleteLocal", reason: "deleted_on_remote" },
      },
      {
        pathLower: "notes/b.md",
        localPath: "notes/b.md",
        action: { type: "deleteLocal", reason: "deleted_on_remote" },
      },
    ]);
    const plan = enhanceSyncPlan(basePlan, {
      localFiles: [
        mkFile("notes/a.md", "n1"),
        mkFile("notes/b.md", "n2"),
      ],
      localFolders: [
        mkFolder("notes"),
        mkFolder("notes/empty"),
      ],
      remoteEntries: [
        mkRemoteFolder("notes (renamed)"),
        mkRemoteFolder("notes (renamed)/empty"),
        mkRemoteFile("notes (renamed)/a.md", "n1"),
        mkRemoteFile("notes (renamed)/b.md", "n2"),
      ],
      baseEntries: [
        mkFolderBase("notes"),
        mkFolderBase("notes/empty"),
        mkFileBase("notes/a.md", "n1"),
        mkFileBase("notes/b.md", "n2"),
      ],
    });

    const folderMoves = actionsOf(plan, "moveLocalFolder");
    expect(folderMoves).toHaveLength(1);
    expect(folderMoves[0]!.action).toMatchObject({
      type: "moveLocalFolder",
      fromPath: "notes",
      toPath: "notes (renamed)",
      reason: "folder_rename_detected",
    });
    expect(actionsOf(plan, "moveLocal")).toHaveLength(0);
    expect(actionsOf(plan, "deleteLocalFolder")).toHaveLength(0);
    expect(actionsOf(plan, "createLocalFolder")).toHaveLength(0);
  });

  test("remote folder move (peer) → moveLocalFolder", () => {
    const plan = enhanceSyncPlan(emptyPlan(), {
      localFiles: [mkFile("folders/nested/deep.md", "d1")],
      localFolders: [
        mkFolder("folders"),
        mkFolder("folders/empty-keep"),
        mkFolder("folders/nested"),
      ],
      remoteEntries: [
        mkRemoteFolder("case"),
        mkRemoteFolder("case/folders"),
        mkRemoteFolder("case/folders/empty-keep"),
        mkRemoteFolder("case/folders/nested"),
        mkRemoteFile("case/folders/nested/deep.md", "d1"),
      ],
      baseEntries: [
        mkFolderBase("folders"),
        mkFolderBase("folders/empty-keep"),
        mkFolderBase("folders/nested"),
        mkFileBase("folders/nested/deep.md", "d1"),
      ],
    });

    const folderMoves = actionsOf(plan, "moveLocalFolder");
    expect(folderMoves).toHaveLength(1);
    expect(folderMoves[0]!.action).toMatchObject({
      type: "moveLocalFolder",
      fromPath: "folders",
      toPath: "case/folders",
    });
    expect(actionsOf(plan, "deleteLocalFolder")).toHaveLength(0);
  });

  test("empty folder rename with unique destination → moveRemoteFolder", () => {
    const plan = enhanceSyncPlan(emptyPlan(), {
      localFiles: [],
      localFolders: [mkFolder("a"), mkFolder("a/newname")],
      remoteEntries: [
        mkRemoteFolder("a"),
        mkRemoteFolder("a/oldname"),
      ],
      baseEntries: [
        mkFolderBase("a"),
        mkFolderBase("a/oldname"),
      ],
    });

    const folderMoves = actionsOf(plan, "moveRemoteFolder");
    expect(folderMoves).toHaveLength(1);
    expect(folderMoves[0]!.action).toMatchObject({
      type: "moveRemoteFolder",
      fromPath: "a/oldname",
      toPath: "a/newname",
      reason: "empty_folder_rename",
    });
  });

  test("ambiguous empty folders → no folder move", () => {
    const plan = enhanceSyncPlan(emptyPlan(), {
      localFiles: [],
      localFolders: [
        mkFolder("a"),
        mkFolder("a/x"),
        mkFolder("a/y"),
      ],
      remoteEntries: [
        mkRemoteFolder("a"),
        mkRemoteFolder("a/old"),
      ],
      baseEntries: [
        mkFolderBase("a"),
        mkFolderBase("a/old"),
      ],
    });

    expect(actionsOf(plan, "moveRemoteFolder")).toHaveLength(0);
    expect(actionsOf(plan, "createRemoteFolder").some(
      (i) => i.pathLower === "a/x" || i.pathLower === "a/y",
    )).toBe(true);
    expect(actionsOf(plan, "deleteRemoteFolder").some(
      (i) => i.pathLower === "a/old",
    )).toBe(true);
  });
});
