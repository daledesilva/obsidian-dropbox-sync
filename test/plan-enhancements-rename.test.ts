import { describe, expect, test } from "bun:test";
import { enhanceSyncPlan, isSyncRootFolderPath } from "@/sync/plan-enhancements";
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

function folderMovePaths(
  plan: { items: SyncPlanItem[] },
  type: "moveRemoteFolder" | "moveLocalFolder",
): { fromPath: string; toPath: string }[] {
  return actionsOf(plan, type).map((item) => {
    const action = item.action as { fromPath: string; toPath: string };
    return { fromPath: action.fromPath, toPath: action.toPath };
  });
}

function isRootishPath(path: string): boolean {
  const trimmed = path.trim();
  return trimmed === "" || trimmed === "/";
}

describe("isSyncRootFolderPath", () => {
  test("empty, slash, and whitespace-only are sync root", () => {
    expect(isSyncRootFolderPath("")).toBe(true);
    expect(isSyncRootFolderPath("/")).toBe(true);
    expect(isSyncRootFolderPath("  ")).toBe(true);
    expect(isSyncRootFolderPath(" / ")).toBe(true);
  });

  test("normal folder paths are not sync root", () => {
    expect(isSyncRootFolderPath("notes")).toBe(false);
    expect(isSyncRootFolderPath("seeds/notes")).toBe(false);
  });
});

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

  test("empty folder rename → create+delete fallback (no moveRemoteFolder)", () => {
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

    expect(actionsOf(plan, "moveRemoteFolder")).toHaveLength(0);
    expect(actionsOf(plan, "createRemoteFolder").some(
      (i) => i.pathLower === "a/newname",
    )).toBe(true);
    expect(actionsOf(plan, "deleteRemoteFolder").some(
      (i) => i.pathLower === "a/oldname",
    )).toBe(true);
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

  test("sync-root is never a folder-rename endpoint", () => {
    // Remnant empty shell gone locally; vault root appears as a local folder candidate.
    const plan = enhanceSyncPlan(emptyPlan(), {
      localFiles: [],
      localFolders: [mkFolder(""), mkFolder("/")],
      remoteEntries: [
        mkRemoteFolder("remnant"),
      ],
      baseEntries: [
        mkFolderBase("remnant"),
      ],
    });

    const moves = [
      ...folderMovePaths(plan, "moveRemoteFolder"),
      ...folderMovePaths(plan, "moveLocalFolder"),
    ];
    expect(moves.some(
      (m) => isRootishPath(m.fromPath) || isRootishPath(m.toPath),
    )).toBe(false);
    expect(actionsOf(plan, "moveRemoteFolder")).toHaveLength(0);
  });

  test("empty folder does not claim a non-empty renamed parent", () => {
    // Thread false-pair: empty-keep → seeds (renamed) while notes live under the parent.
    const plan = enhanceSyncPlan(emptyPlan(), {
      localFiles: [mkFile("seeds (renamed)/notes/a.md", "a1")],
      localFolders: [
        mkFolder("seeds (renamed)"),
        mkFolder("seeds (renamed)/notes"),
      ],
      remoteEntries: [
        mkRemoteFolder("seeds"),
        mkRemoteFolder("seeds/notes"),
        mkRemoteFolder("seeds/empty-keep"),
        mkRemoteFile("seeds/notes/a.md", "a1"),
      ],
      baseEntries: [
        mkFolderBase("seeds"),
        mkFolderBase("seeds/notes"),
        mkFolderBase("seeds/empty-keep"),
        mkFileBase("seeds/notes/a.md", "a1"),
      ],
    });

    expect(folderMovePaths(plan, "moveRemoteFolder").some(
      (m) => m.fromPath === "seeds/empty-keep" && m.toPath === "seeds (renamed)",
    )).toBe(false);
  });

  test("sibling folder renames in one cycle → two moveRemoteFolders, no cross-claim", () => {
    const plan = enhanceSyncPlan(emptyPlan(), {
      localFiles: [
        mkFile("seeds/notes-renamed/a.md", "a1"),
        mkFile("seeds/bulk-renamed/b.md", "b1"),
      ],
      localFolders: [
        mkFolder("seeds"),
        mkFolder("seeds/notes-renamed"),
        mkFolder("seeds/bulk-renamed"),
      ],
      remoteEntries: [
        mkRemoteFolder("seeds"),
        mkRemoteFolder("seeds/notes"),
        mkRemoteFolder("seeds/bulk"),
        mkRemoteFile("seeds/notes/a.md", "a1"),
        mkRemoteFile("seeds/bulk/b.md", "b1"),
      ],
      baseEntries: [
        mkFolderBase("seeds"),
        mkFolderBase("seeds/notes"),
        mkFolderBase("seeds/bulk"),
        mkFileBase("seeds/notes/a.md", "a1"),
        mkFileBase("seeds/bulk/b.md", "b1"),
      ],
    });

    const moves = folderMovePaths(plan, "moveRemoteFolder");
    expect(moves).toHaveLength(2);
    expect(moves).toContainEqual({
      fromPath: "seeds/notes",
      toPath: "seeds/notes-renamed",
    });
    expect(moves).toContainEqual({
      fromPath: "seeds/bulk",
      toPath: "seeds/bulk-renamed",
    });
    expect(moves.some(
      (m) => m.fromPath === "seeds/notes" && m.toPath === "seeds/bulk-renamed",
    )).toBe(false);
    expect(actionsOf(plan, "deleteRemoteFolder").some(
      (i) => i.pathLower === "seeds/notes" || i.pathLower === "seeds/bulk",
    )).toBe(false);
  });

  test("inner content change at same relative path blocks G8", () => {
    const plan = enhanceSyncPlan(emptyPlan(), {
      localFiles: [mkFile("notes-renamed/baseline.md", "edited")],
      localFolders: [mkFolder("notes-renamed")],
      remoteEntries: [
        mkRemoteFolder("notes"),
        mkRemoteFile("notes/baseline.md", "original"),
      ],
      baseEntries: [
        mkFolderBase("notes"),
        mkFileBase("notes/baseline.md", "original"),
      ],
    });

    expect(actionsOf(plan, "moveRemoteFolder")).toHaveLength(0);
  });

  test("child moved out of renamed parent → no false child→parent folder move", () => {
    // notes relocated to vault root; bulk stayed under renamed seeds parent.
    const plan = enhanceSyncPlan(emptyPlan(), {
      localFiles: [
        mkFile("notes (renamed)/a.md", "a1"),
        mkFile("seeds (renamed)/bulk/b.md", "b1"),
      ],
      localFolders: [
        mkFolder("notes (renamed)"),
        mkFolder("seeds (renamed)"),
        mkFolder("seeds (renamed)/bulk"),
      ],
      remoteEntries: [
        mkRemoteFolder("seeds"),
        mkRemoteFolder("seeds/notes"),
        mkRemoteFolder("seeds/bulk"),
        mkRemoteFile("seeds/notes/a.md", "a1"),
        mkRemoteFile("seeds/bulk/b.md", "b1"),
      ],
      baseEntries: [
        mkFolderBase("seeds"),
        mkFolderBase("seeds/notes"),
        mkFolderBase("seeds/bulk"),
        mkFileBase("seeds/notes/a.md", "a1"),
        mkFileBase("seeds/bulk/b.md", "b1"),
      ],
    });

    const moves = folderMovePaths(plan, "moveRemoteFolder");
    expect(moves.some(
      (m) => m.fromPath === "seeds/notes" && m.toPath === "seeds (renamed)",
    )).toBe(false);
    // Child may move to its own dest; parent may fail (child left the tree) — either is fine.
    expect(moves.some(
      (m) => m.fromPath === "seeds/notes" && m.toPath === "notes (renamed)",
    )).toBe(true);
  });

  test("folder rename + inner file rename → no folder move; G7 file move fallback", () => {
    // Same-relative-path score fails when an inner file also renamed.
    const plan = enhanceSyncPlan(emptyPlan(), {
      localFiles: [mkFile("notes-renamed/baseline-renamed.md", "h1")],
      localFolders: [mkFolder("notes-renamed")],
      remoteEntries: [
        mkRemoteFolder("notes"),
        mkRemoteFile("notes/baseline.md", "h1"),
      ],
      baseEntries: [
        mkFolderBase("notes"),
        mkFileBase("notes/baseline.md", "h1"),
      ],
    });

    expect(actionsOf(plan, "moveRemoteFolder")).toHaveLength(0);
    const fileMoves = actionsOf(plan, "moveRemote");
    expect(fileMoves).toHaveLength(1);
    expect(fileMoves[0]!.action).toMatchObject({
      type: "moveRemote",
      fromPath: "notes/baseline.md",
      toPath: "notes-renamed/baseline-renamed.md",
    });
    expect(fileMoves[0]!.action.reason).not.toBe("empty_folder_rename");
  });

  test("small populated folder does not claim larger renamed parent (bijection)", () => {
    // notes files live under seeds-renamed/notes — notes must not match seeds-renamed.
    const plan = enhanceSyncPlan(emptyPlan(), {
      localFiles: [
        mkFile("seeds-renamed/notes/a.md", "a1"),
        mkFile("seeds-renamed/bulk/b.md", "b1"),
      ],
      localFolders: [
        mkFolder("seeds-renamed"),
        mkFolder("seeds-renamed/notes"),
        mkFolder("seeds-renamed/bulk"),
      ],
      remoteEntries: [
        mkRemoteFolder("seeds"),
        mkRemoteFolder("seeds/notes"),
        mkRemoteFolder("seeds/bulk"),
        mkRemoteFile("seeds/notes/a.md", "a1"),
        mkRemoteFile("seeds/bulk/b.md", "b1"),
      ],
      baseEntries: [
        mkFolderBase("seeds"),
        mkFolderBase("seeds/notes"),
        mkFolderBase("seeds/bulk"),
        mkFileBase("seeds/notes/a.md", "a1"),
        mkFileBase("seeds/bulk/b.md", "b1"),
      ],
    });

    const folderMoves = actionsOf(plan, "moveRemoteFolder");
    expect(folderMoves.some(
      (i) => i.action.type === "moveRemoteFolder"
        && (i.action as { fromPath: string }).fromPath === "seeds/notes"
        && (i.action as { toPath: string }).toPath === "seeds-renamed",
    )).toBe(false);
    // Intact parent tree should still move as one folder.
    expect(folderMoves.some(
      (i) => i.action.type === "moveRemoteFolder"
        && (i.action as { fromPath: string }).fromPath === "seeds"
        && (i.action as { toPath: string }).toPath === "seeds-renamed",
    )).toBe(true);
  });

  test("peer empty folder rename → no moveLocalFolder (create+delete fallback)", () => {
    const plan = enhanceSyncPlan(emptyPlan(), {
      localFiles: [],
      localFolders: [mkFolder("a"), mkFolder("a/oldname")],
      remoteEntries: [
        mkRemoteFolder("a"),
        mkRemoteFolder("a/newname"),
      ],
      baseEntries: [
        mkFolderBase("a"),
        mkFolderBase("a/oldname"),
      ],
    });

    expect(actionsOf(plan, "moveLocalFolder")).toHaveLength(0);
    expect(actionsOf(plan, "createLocalFolder").some(
      (i) => i.pathLower === "a/newname",
    )).toBe(true);
    expect(actionsOf(plan, "deleteLocalFolder").some(
      (i) => i.pathLower === "a/oldname",
    )).toBe(true);
  });

  test("peer small folder does not claim larger renamed parent (bijection)", () => {
    const plan = enhanceSyncPlan(emptyPlan(), {
      localFiles: [
        mkFile("seeds/notes/a.md", "a1"),
        mkFile("seeds/bulk/b.md", "b1"),
      ],
      localFolders: [
        mkFolder("seeds"),
        mkFolder("seeds/notes"),
        mkFolder("seeds/bulk"),
      ],
      remoteEntries: [
        mkRemoteFolder("seeds-renamed"),
        mkRemoteFolder("seeds-renamed/notes"),
        mkRemoteFolder("seeds-renamed/bulk"),
        mkRemoteFile("seeds-renamed/notes/a.md", "a1"),
        mkRemoteFile("seeds-renamed/bulk/b.md", "b1"),
      ],
      baseEntries: [
        mkFolderBase("seeds"),
        mkFolderBase("seeds/notes"),
        mkFolderBase("seeds/bulk"),
        mkFileBase("seeds/notes/a.md", "a1"),
        mkFileBase("seeds/bulk/b.md", "b1"),
      ],
    });

    const moves = folderMovePaths(plan, "moveLocalFolder");
    expect(moves.some(
      (m) => m.fromPath === "seeds/notes" && m.toPath === "seeds-renamed",
    )).toBe(false);
    expect(moves.some(
      (m) => m.fromPath === "seeds" && m.toPath === "seeds-renamed",
    )).toBe(true);
  });
});
