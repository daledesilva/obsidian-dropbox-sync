import { describe, test, expect, beforeEach } from "bun:test";
import { applyResurrectionGuard } from "@/sync/resurrection-guard";
import { MemoryRemoteStorage } from "@/adapters/memory";
import type { RemoteStorage } from "@/adapters/interfaces";
import type { SyncPlan, SyncPlanItem } from "@/types";
import { emptySyncPlanStats } from "@/types";

function mkNewLocal(path: string): SyncPlanItem {
  return {
    pathLower: path.toLowerCase(),
    localPath: path,
    action: { type: "upload", reason: "new_local" },
  };
}

function mkPlan(...items: SyncPlanItem[]): SyncPlan {
  const stats = emptySyncPlanStats();
  for (const item of items) {
    const key = item.action.type;
    if (key in stats) (stats as Record<string, number>)[key]++;
  }
  return { items, stats };
}

describe("applyResurrectionGuard", () => {
  let remote: MemoryRemoteStorage;

  beforeEach(() => {
    remote = new MemoryRemoteStorage();
  });

  test("fresh join + deletion evidence → preserveAsConflictCopy (R10)", async () => {
    await remote.upload("note.md", new TextEncoder().encode("doomed"));
    await remote.delete("note.md");

    const plan = mkPlan(mkNewLocal("note.md"));
    const result = await applyResurrectionGuard(plan, remote, {
      hasSyncCursor: false,
    });

    expect(result.plan.items).toHaveLength(1);
    const action = result.plan.items[0].action;
    expect(action.type).toBe("preserveAsConflictCopy");
    if (action.type === "preserveAsConflictCopy") {
      expect(action.reason).toBe("r10_deletion_evidence");
    }
    expect(result.deferredNewLocalCount).toBe(0);
    expect(result.deferPathsToRemember).toEqual([]);
  });

  test("fresh join + no deletion evidence → ask once; upload keeps new_local", async () => {
    await remote.upload("fresh.md", new TextEncoder().encode("never deleted"));

    let askedPaths: string[] | null = null;
    const plan = mkPlan(mkNewLocal("fresh.md"), mkNewLocal("other.md"));
    const result = await applyResurrectionGuard(plan, remote, {
      hasSyncCursor: false,
      resolver: async (paths) => {
        askedPaths = paths;
        return "upload";
      },
    });

    // Both lack deletion evidence → one batch ask covering both.
    expect(askedPaths).toEqual(["fresh.md", "other.md"]);
    expect(result.plan.items.every((i) => i.action.type === "upload")).toBe(true);
    expect(result.deferPathsToClear).toEqual(["fresh.md", "other.md"]);
    expect(result.deferredNewLocalCount).toBe(0);
  });

  test("fresh join + no evidence → discard turns paths into deleteLocal", async () => {
    const plan = mkPlan(mkNewLocal("stale.md"));
    const result = await applyResurrectionGuard(plan, remote, {
      hasSyncCursor: false,
      resolver: async () => "discard",
    });

    expect(result.plan.items).toHaveLength(1);
    const action = result.plan.items[0].action;
    expect(action.type).toBe("deleteLocal");
    if (action.type === "deleteLocal") {
      expect(action.reason).toBe("resurrection_discarded");
    }
    expect(result.deferPathsToClear).toEqual(["stale.md"]);
  });

  test("fresh join + no evidence → defer holds uploads and remembers paths", async () => {
    const plan = mkPlan(mkNewLocal("held.md"));
    const result = await applyResurrectionGuard(plan, remote, {
      hasSyncCursor: false,
      resolver: async () => "defer",
    });

    expect(result.plan.items).toHaveLength(0);
    expect(result.deferredNewLocalCount).toBe(1);
    expect(result.deferPathsToRemember).toEqual(["held.md"]);
  });

  test("linked device (hasSyncCursor) skips R10/R6 for ordinary new_local", async () => {
    // Even with deletion history on Dropbox, a linked device must not rewrite
    // intentional creates into conflict copies — that is the "not R10 when linked" rule.
    await remote.upload("note.md", new TextEncoder().encode("old"));
    await remote.delete("note.md");

    let asked = false;
    const plan = mkPlan(mkNewLocal("note.md"));
    const result = await applyResurrectionGuard(plan, remote, {
      hasSyncCursor: true,
      resolver: async () => {
        asked = true;
        return "upload";
      },
    });

    expect(asked).toBe(false);
    expect(result.plan.items).toHaveLength(1);
    expect(result.plan.items[0].action.type).toBe("upload");
    if (result.plan.items[0].action.type === "upload") {
      expect(result.plan.items[0].action.reason).toBe("new_local");
    }
  });

  test("linked device still gates previously deferred new_local paths", async () => {
    let askedPaths: string[] | null = null;
    const plan = mkPlan(mkNewLocal("held.md"), mkNewLocal("free.md"));
    const result = await applyResurrectionGuard(plan, remote, {
      hasSyncCursor: true,
      previouslyDeferredPathLowers: new Set(["held.md"]),
      resolver: async (paths) => {
        askedPaths = paths;
        return "upload";
      },
    });

    expect(askedPaths).toEqual(["held.md"]);
    expect(result.plan.items.map((i) => i.localPath).sort()).toEqual(["free.md", "held.md"]);
    expect(result.deferPathsToClear).toEqual(["held.md"]);
  });

  test("non-new_local items pass through untouched", async () => {
    await remote.upload("note.md", new TextEncoder().encode("x"));
    await remote.delete("note.md");

    const downloadItem: SyncPlanItem = {
      pathLower: "other.md",
      localPath: "other.md",
      action: {
        type: "download",
        reason: "new_remote",
        rev: "r1",
        remoteHash: "h",
        pathDisplay: "other.md",
      },
    };
    const editWins: SyncPlanItem = {
      pathLower: "edited.md",
      localPath: "edited.md",
      action: { type: "upload", reason: "local_modified_remote_deleted" },
    };
    const plan = mkPlan(mkNewLocal("note.md"), downloadItem, editWins);
    const result = await applyResurrectionGuard(plan, remote, {
      hasSyncCursor: false,
    });

    const byPath = new Map(result.plan.items.map((i) => [i.pathLower, i.action.type]));
    expect(byPath.get("note.md")).toBe("preserveAsConflictCopy");
    expect(byPath.get("other.md")).toBe("download");
    expect(byPath.get("edited.md")).toBe("upload");
  });

  test("missing listRevisions → ask path (never silent upload)", async () => {
    // Adapter without listRevisions — guard must ask, never silently upload.
    const noRevisionsRemote: RemoteStorage = {
      listChanges: (cursor) => remote.listChanges(cursor),
      download: (path) => remote.download(path),
      upload: (path, data, rev, clientModified) =>
        remote.upload(path, data, rev, clientModified),
      delete: (path) => remote.delete(path),
      deleteBatch: (paths) => remote.deleteBatch(paths),
      listFilePathLowersUnder: (folderPath) =>
        remote.listFilePathLowersUnder(folderPath),
      move: (from, to) => remote.move(from, to),
      createFolder: (path) => remote.createFolder(path),
    };

    let asked = false;
    const plan = mkPlan(mkNewLocal("mystery.md"));
    const result = await applyResurrectionGuard(plan, noRevisionsRemote, {
      hasSyncCursor: false,
      resolver: async () => {
        asked = true;
        return "defer";
      },
    });

    expect(asked).toBe(true);
    expect(result.plan.items).toHaveLength(0);
    expect(result.deferredNewLocalCount).toBe(1);
    expect(result.deferPathsToRemember).toEqual(["mystery.md"]);
  });

  test("fresh join + expired revisions → ask (R6), not R10", async () => {
    await remote.upload("aged.md", new TextEncoder().encode("old"));
    await remote.delete("aged.md");
    remote.expireRevisions("aged.md");

    let asked = false;
    const plan = mkPlan(mkNewLocal("aged.md"));
    const result = await applyResurrectionGuard(plan, remote, {
      hasSyncCursor: false,
      resolver: async () => {
        asked = true;
        return "upload";
      },
    });

    expect(asked).toBe(true);
    expect(result.plan.items[0].action.type).toBe("upload");
  });
});
