import { describe, test, expect, beforeEach } from "bun:test";
import { executePlan, makeConflictPath } from "@/sync/executor";
import { findNewestConflictSibling } from "@/sync/conflict-handlers";
import { patchDeviceSettings } from "@/device-settings/device-settings";
import type { ExecutorDeps, ExecutorConfig } from "@/sync/executor";
import {
  MemoryFileSystem,
  MemoryRemoteStorage,
  MemoryStateStore,
} from "@/adapters/memory";
import { dropboxContentHash } from "@/hash";
import type { SyncPlan, SyncPlanItem } from "@/types";
import { emptySyncPlanStats, PathValidationError } from "@/types";

function mkPlan(...items: SyncPlanItem[]): SyncPlan {
  const stats = emptySyncPlanStats();
  for (const item of items) {
    const key = item.action.type;
    if (key in stats) (stats as Record<string, number>)[key]++;
  }
  return { items, stats };
}

async function findConflictSibling(
  fs: MemoryFileSystem,
  canonicalPath: string,
): Promise<string | undefined> {
  const files = await fs.list();
  return findNewestConflictSibling(files.map((f) => f.path), canonicalPath) ?? undefined;
}

describe("executePlan", () => {
  let fs: MemoryFileSystem;
  let remote: MemoryRemoteStorage;
  let store: MemoryStateStore;
  let deps: ExecutorDeps;

  beforeEach(() => {
    patchDeviceSettings({ deviceId: "test" });
    fs = new MemoryFileSystem();
    remote = new MemoryRemoteStorage();
    store = new MemoryStateStore();
    deps = { fs, remote, store };
  });

  // ── upload ──

  test("upload: 로컬 파일을 원격에 업로드", async () => {
    const data = new TextEncoder().encode("local content");
    await fs.write("test.md", data);

    const plan = mkPlan({
      pathLower: "test.md",
      localPath: "test.md",
      action: { type: "upload", reason: "new_local" },
    });

    const result = await executePlan(plan, deps);
    expect(result.succeeded).toHaveLength(1);
    expect(result.failed).toHaveLength(0);

    // 원격에 파일 존재
    const dl = await remote.download("test.md");
    expect(dl.data).toEqual(data);

    // state 갱신됨
    const entry = await store.getEntry("test.md");
    expect(entry).not.toBeNull();
    expect(entry!.rev).toBeTruthy();
    expect(entry!.baseLocalHash).toBe(await dropboxContentHash(data));
  });

  test("upload: rev 충돌 → conflict 파일 생성", async () => {
    // 원격에 다른 내용으로 파일 존재
    const remoteData = new TextEncoder().encode("remote version");
    const remoteEntry = await remote.upload("test.md", remoteData);

    // 로컬 파일
    const localData = new TextEncoder().encode("local version");
    await fs.write("test.md", localData);

    // base에 오래된 rev 기록
    await store.setEntry({
      pathLower: "test.md",
      localPath: "test.md",
      baseLocalHash: "old_hash",
      baseRemoteHash: "old_hash",
      rev: "wrong_rev", // 일부러 불일치
      lastSynced: 1000,
    });

    const plan = mkPlan({
      pathLower: "test.md",
      localPath: "test.md",
      action: { type: "upload", reason: "local_modified" },
    });

    const result = await executePlan(plan, deps);
    expect(result.succeeded).toHaveLength(1);

    // conflict 파일에 로컬 버전, canonical은 원격 유지 (R2)
    const conflictPath = await findConflictSibling(fs, "test.md");
    expect(conflictPath).toBeDefined();
    const conflictData = await fs.read(conflictPath!);
    expect(conflictData).toEqual(localData);

    expect(await fs.read("test.md")).toEqual(remoteData);

    const remoteDl = await remote.download("test.md");
    expect(remoteDl.data).toEqual(remoteData);
    const conflictRemote = await remote.download(conflictPath!);
    expect(conflictRemote.data).toEqual(localData);
  });

  test("upload: rev 충돌 + remote not_found → stale rev 버리고 fresh upload", async () => {
    const localData = new TextEncoder().encode("local version");
    await fs.write("test.md", localData);

    // 원격에 파일 존재 (upload 시 RevConflictError 유발용)
    const remoteData = new TextEncoder().encode("remote version");
    await remote.upload("test.md", remoteData);

    // stale rev로 store 설정
    await store.setEntry({
      pathLower: "test.md",
      localPath: "test.md",
      baseLocalHash: "old_hash",
      baseRemoteHash: "old_hash",
      rev: "wrong_rev",
      lastSynced: 1000,
    });

    // download를 not_found로 실패시킴 (conflict handler가 remote 파일을 못 찾는 상황)
    const origDownload = remote.download.bind(remote);
    let downloadCallCount = 0;
    remote.download = async (path: string) => {
      downloadCallCount++;
      throw new Error(`Dropbox API error 409: path/not_found`);
    };

    // Remote gone — add-mode retry should succeed (G29).
    await remote.delete("test.md");

    const plan = mkPlan({
      pathLower: "test.md",
      localPath: "test.md",
      action: { type: "upload", reason: "local_modified" },
    });

    const result = await executePlan(plan, deps);
    expect(result.succeeded).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    expect(downloadCallCount).toBe(1); // conflict handler가 download 시도함

    // fresh upload으로 복구 → state에 새 rev
    const entry = await store.getEntry("test.md");
    expect(entry).not.toBeNull();
    expect(entry!.rev).not.toBe("wrong_rev");
  });

  // ── download ──

  test("download: 원격 파일을 로컬에 다운로드", async () => {
    const data = new TextEncoder().encode("remote content");
    await remote.upload("test.md", data);

    const plan = mkPlan({
      pathLower: "test.md",
      localPath: "test.md",
      action: { type: "download", reason: "new_remote" },
    });

    const result = await executePlan(plan, deps);
    expect(result.succeeded).toHaveLength(1);

    // 로컬에 파일 존재
    const localData = await fs.read("test.md");
    expect(localData).toEqual(data);

    // state 갱신됨
    const entry = await store.getEntry("test.md");
    expect(entry).not.toBeNull();
    expect(entry!.baseLocalHash).toBe(await dropboxContentHash(data));
  });

  // ── deleteLocal ──

  test("deleteLocal: 로컬 파일 삭제", async () => {
    await fs.write("test.md", new TextEncoder().encode("x"));
    await store.setEntry({
      pathLower: "test.md",
      localPath: "test.md",
      baseLocalHash: "h",
      baseRemoteHash: "h",
      rev: "r",
      lastSynced: 1000,
    });

    const plan = mkPlan({
      pathLower: "test.md",
      localPath: "test.md",
      action: { type: "deleteLocal", reason: "deleted_on_remote" },
    });

    const result = await executePlan(plan, deps);
    expect(result.succeeded).toHaveLength(1);
    expect(fs.has("test.md")).toBe(false);
    expect(await store.getEntry("test.md")).toBeNull();
  });

  test("deleteLocal: onBeforeDeleteLocal 콜백 호출", async () => {
    await fs.write("test.md", new TextEncoder().encode("x"));
    await store.setEntry({
      pathLower: "test.md",
      localPath: "test.md",
      baseLocalHash: "h",
      baseRemoteHash: "h",
      rev: "r",
      lastSynced: 1000,
    });

    const plan = mkPlan({
      pathLower: "test.md",
      localPath: "test.md",
      action: { type: "deleteLocal", reason: "deleted_on_remote" },
    });

    const deletedPaths: string[] = [];
    const config: ExecutorConfig = {
      onBeforeDeleteLocal: (p) => deletedPaths.push(p),
    };

    await executePlan(plan, deps, config);
    expect(deletedPaths).toEqual(["test.md"]);
  });

  // ── deleteRemote ──

  test("deleteRemote: 원격 파일 삭제", async () => {
    await remote.upload("test.md", new TextEncoder().encode("x"));
    await store.setEntry({
      pathLower: "test.md",
      localPath: "test.md",
      baseLocalHash: "h",
      baseRemoteHash: "h",
      rev: "r",
      lastSynced: 1000,
    });

    const plan = mkPlan({
      pathLower: "test.md",
      localPath: "test.md",
      action: { type: "deleteRemote", reason: "deleted_on_local" },
    });

    const result = await executePlan(plan, deps);
    expect(result.succeeded).toHaveLength(1);
    expect(remote.has("test.md")).toBe(false);
    expect(await store.getEntry("test.md")).toBeNull();
    expect(remote.deleteBatchCallCount).toBe(1);
  });

  test("deleteRemote: many files use deleteBatch and return original items", async () => {
    const paths = ["a.md", "b.md", "c.md", "d.md"];
    for (const path of paths) {
      await remote.upload(path, new TextEncoder().encode(path));
      await store.setEntry({
        pathLower: path,
        localPath: path,
        baseLocalHash: "h",
        baseRemoteHash: "h",
        rev: "r",
        lastSynced: 1000,
      });
    }

    const plan = mkPlan(
      ...paths.map((path) => ({
        pathLower: path,
        localPath: path,
        action: { type: "deleteRemote" as const, reason: "deleted_on_local" },
      })),
    );

    const result = await executePlan(plan, deps, {
      existingRemotePathLowers: paths,
    });
    expect(result.succeeded).toHaveLength(4);
    expect(result.succeeded.map((i) => i.pathLower).sort()).toEqual([...paths].sort());
    expect(remote.deleteBatchCallCount).toBe(1);
    for (const path of paths) {
      expect(remote.has(path)).toBe(false);
      expect(await store.getEntry(path)).toBeNull();
    }
  });

  test("deleteRemote: folder coalesce deletes prefix and clears all covered store entries", async () => {
    const paths = ["notes/a.md", "notes/b.md", "notes/c.md"];
    for (const path of paths) {
      const entry = await remote.upload(path, new TextEncoder().encode(path));
      await store.setEntry({
        pathLower: path,
        localPath: path,
        baseLocalHash: entry.hash,
        baseRemoteHash: entry.hash,
        rev: entry.rev,
        lastSynced: 1000,
      });
    }

    const plan = mkPlan(
      ...paths.map((path) => ({
        pathLower: path,
        localPath: path,
        action: { type: "deleteRemote" as const, reason: "deleted_on_local" },
      })),
    );

    const result = await executePlan(plan, deps, {
      existingRemotePathLowers: paths,
    });

    expect(remote.deleteBatchCallCount).toBe(1);
    expect(remote.lastDeleteBatchPaths).toEqual(["notes"]);
    expect(result.succeeded).toHaveLength(3);
    expect(result.succeeded.map((i) => i.pathLower).sort()).toEqual([...paths].sort());
    for (const path of paths) {
      expect(remote.has(path)).toBe(false);
      expect(await store.getEntry(path)).toBeNull();
    }
  });

  test("deleteRemote: live list extra file blocks folder delete", async () => {
    const planned = ["notes/a.md", "notes/b.md"];
    for (const path of [...planned, "notes/secret.md"]) {
      const entry = await remote.upload(path, new TextEncoder().encode(path));
      await store.setEntry({
        pathLower: path,
        localPath: path,
        baseLocalHash: entry.hash,
        baseRemoteHash: entry.hash,
        rev: entry.rev,
        lastSynced: 1000,
      });
    }

    const plan = mkPlan(
      ...planned.map((path) => ({
        pathLower: path,
        localPath: path,
        action: { type: "deleteRemote" as const, reason: "deleted_on_local" },
      })),
    );

    // Snapshot omits secret.md so coalesce proposes notes/ — live list must reject it.
    const result = await executePlan(plan, deps, {
      existingRemotePathLowers: planned,
    });

    expect(remote.lastDeleteBatchPaths.sort()).toEqual([...planned].sort());
    expect(remote.lastDeleteBatchPaths).not.toContain("notes");
    expect(result.succeeded).toHaveLength(2);
    expect(remote.has("notes/secret.md")).toBe(true);
  });

  test("deleteRemote: live hash ≠ base downloads instead of deleting", async () => {
    const paths = ["notes/a.md", "notes/b.md", "notes/c.md"];
    for (const path of paths) {
      const entry = await remote.upload(path, new TextEncoder().encode(`v1-${path}`));
      await store.setEntry({
        pathLower: path,
        localPath: path,
        baseLocalHash: entry.hash,
        baseRemoteHash: entry.hash,
        rev: entry.rev,
        lastSynced: 1000,
      });
    }
    // Remote edited after plan-time base — must not be wiped by folder delete.
    const cBase = await store.getEntry("notes/c.md");
    await remote.upload(
      "notes/c.md",
      new TextEncoder().encode("edited-on-ipad"),
      cBase!.rev!,
    );

    const plan = mkPlan(
      ...paths.map((path) => ({
        pathLower: path,
        localPath: path,
        action: { type: "deleteRemote" as const, reason: "deleted_on_local" },
      })),
    );

    const result = await executePlan(plan, deps, {
      existingRemotePathLowers: paths,
    });

    expect(remote.lastDeleteBatchPaths.sort()).toEqual(["notes/a.md", "notes/b.md"]);
    expect(remote.has("notes/c.md")).toBe(true);
    const rescued = result.succeeded.find((i) => i.pathLower === "notes/c.md");
    expect(rescued?.action.type).toBe("download");
    expect(await fs.read("notes/c.md")).toEqual(
      new TextEncoder().encode("edited-on-ipad"),
    );
    expect(remote.has("notes/a.md")).toBe(false);
    expect(remote.has("notes/b.md")).toBe(false);
  });

  test("deleteRemote: already-absent path soft-succeeds via batch", async () => {
    await store.setEntry({
      pathLower: "stale.md",
      localPath: "stale.md",
      baseLocalHash: "h",
      baseRemoteHash: "h",
      rev: "r",
      lastSynced: 1000,
    });

    const plan = mkPlan({
      pathLower: "stale.md",
      localPath: "stale.md",
      action: { type: "deleteRemote", reason: "deleted_on_local" },
    });

    const result = await executePlan(plan, deps, {
      existingRemotePathLowers: [],
    });
    expect(result.succeeded).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    expect(await store.getEntry("stale.md")).toBeNull();
  });

  // ── deleteRemoteFolder / deleteLocalFolder ──

  test("deleteRemoteFolder: path not_found soft-succeeds", async () => {
    await store.setEntry({
      pathLower: "gone-tree",
      localPath: "gone-tree",
      baseLocalHash: null,
      baseRemoteHash: null,
      rev: null,
      lastSynced: 1000,
      entryKind: "folder",
    });

    const plan = mkPlan({
      pathLower: "gone-tree",
      localPath: "gone-tree",
      action: { type: "deleteRemoteFolder", reason: "inferred_local_tree_wipe" },
    });

    const result = await executePlan(plan, deps);
    expect(result.failed).toHaveLength(0);
    expect(result.succeeded).toHaveLength(1);
    expect(result.succeeded[0].action.type).toBe("deleteRemoteFolder");
    expect(await store.getEntry("gone-tree")).toBeNull();
  });

  test("deleteLocalFolder runs after deleteLocal children", async () => {
    await fs.createFolder("tree");
    await fs.write("tree/a.md", new TextEncoder().encode("a"));
    await fs.write("tree/b.md", new TextEncoder().encode("b"));

    const callOrder: string[] = [];
    const origDelete = fs.delete.bind(fs);
    const origDeleteFolder = fs.deleteFolder.bind(fs);
    fs.delete = async (path: string) => {
      callOrder.push(`file:${path}`);
      return origDelete(path);
    };
    fs.deleteFolder = async (path: string) => {
      callOrder.push(`folder:${path}`);
      return origDeleteFolder(path);
    };

    const plan = mkPlan(
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
      {
        pathLower: "tree",
        localPath: "tree",
        action: { type: "deleteLocalFolder", reason: "deleted_on_remote" },
      },
    );

    const result = await executePlan(plan, deps);
    expect(result.failed).toHaveLength(0);
    expect(result.succeeded).toHaveLength(3);
    const folderIdx = callOrder.indexOf("folder:tree");
    expect(folderIdx).toBeGreaterThan(-1);
    expect(callOrder.indexOf("file:tree/a.md")).toBeLessThan(folderIdx);
    expect(callOrder.indexOf("file:tree/b.md")).toBeLessThan(folderIdx);
    expect(fs.has("tree/a.md")).toBe(false);
    expect((await fs.listFolders()).some((f) => f.pathLower === "tree")).toBe(false);
  });

  // ── conflict ──

  test("conflict: 양쪽 파일 모두 보존", async () => {
    const localData = new TextEncoder().encode("local version");
    const remoteData = new TextEncoder().encode("remote version");

    await fs.write("test.md", localData);
    await remote.upload("test.md", remoteData);

    const plan = mkPlan({
      pathLower: "test.md",
      localPath: "test.md",
      action: {
        type: "conflict",
        localHash: await dropboxContentHash(localData),
        remoteHash: await dropboxContentHash(remoteData),
      },
    });

    const result = await executePlan(plan, deps);
    expect(result.succeeded).toHaveLength(1);

    // canonical은 원격, conflict sibling은 로컬 (R2)
    expect(await fs.read("test.md")).toEqual(remoteData);

    const conflictPath = await findConflictSibling(fs, "test.md");
    expect(conflictPath).toBeDefined();
    expect(await fs.read(conflictPath!)).toEqual(localData);

    const dl = await remote.download("test.md");
    expect(dl.data).toEqual(remoteData);
    const conflictRemote = await remote.download(conflictPath!);
    expect(conflictRemote.data).toEqual(localData);

    // state 갱신
    const entry = await store.getEntry("test.md");
    expect(entry).not.toBeNull();
  });

  // ── partial failure ──

  test("partial failure: 일부 실패해도 나머지 계속 진행", async () => {
    // 성공할 파일
    const data = new TextEncoder().encode("content");
    await fs.write("good.md", data);

    // 실패할 파일 (원격에 없는데 download 시도)
    const plan = mkPlan(
      {
        pathLower: "good.md",
        localPath: "good.md",
        action: { type: "upload", reason: "new_local" },
      },
      {
        pathLower: "bad.md",
        localPath: "bad.md",
        action: { type: "download", reason: "new_remote" },
      },
    );

    const result = await executePlan(plan, deps);
    expect(result.succeeded).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].item.pathLower).toBe("bad.md");
  });

  // ── 여러 액션 동시 실행 ──

  test("여러 파일 동시 처리", async () => {
    await fs.write("upload.md", new TextEncoder().encode("u"));
    await remote.upload("download.md", new TextEncoder().encode("d"));

    const plan = mkPlan(
      {
        pathLower: "upload.md",
        localPath: "upload.md",
        action: { type: "upload", reason: "new_local" },
      },
      {
        pathLower: "download.md",
        localPath: "download.md",
        action: { type: "download", reason: "new_remote" },
      },
    );

    const result = await executePlan(plan, deps);
    expect(result.succeeded).toHaveLength(2);
    expect(result.failed).toHaveLength(0);

    // 양쪽 모두 처리됨
    expect(remote.has("upload.md")).toBe(true);
    expect(fs.has("download.md")).toBe(true);
  });

  // ── noop ──

  test("recordBase: sync base refreshed without transfer", async () => {
    await fs.write("test.md", new TextEncoder().encode("same"));
    await remote.upload("test.md", new TextEncoder().encode("same"));

    const plan = mkPlan({
      pathLower: "test.md",
      localPath: "test.md",
      action: {
        type: "recordBase",
        reason: "same_content",
        localHash: "abc",
        remoteHash: "abc",
        rev: "rev_1",
        pathDisplay: "test.md",
      },
    });

    const result = await executePlan(plan, deps);
    expect(result.succeeded).toHaveLength(1);
    expect(store.getEntryCount()).toBe(1);
    const entry = await store.getEntry("test.md");
    expect(entry?.basePathDisplay).toBe("test.md");
  });

  // ── 빈 플랜 ──

  test("빈 플랜: 성공, 변경 없음", async () => {
    const plan = mkPlan();
    const result = await executePlan(plan, deps);
    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(result.deferred).toHaveLength(0);
  });

  // ── path validation ──

  test("upload: 제어문자 경로 → PathValidationError로 실패", async () => {
    await fs.write("file\x01.md", new TextEncoder().encode("content"));
    const plan = mkPlan({
      pathLower: "file\x01.md",
      localPath: "file\x01.md",
      action: { type: "upload", reason: "new_local" },
    });

    const result = await executePlan(plan, deps);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toBeInstanceOf(PathValidationError);
  });

  // ── 활성 파일 보호 ──

  test("download: 활성 파일 → deferred로 건너뜀", async () => {
    await remote.upload("active.md", new TextEncoder().encode("remote"));

    const plan = mkPlan({
      pathLower: "active.md",
      localPath: "active.md",
      action: { type: "download", reason: "new_remote" },
    });

    const result = await executePlan(plan, deps, {
      isFileActive: (path) => path === "active.md",
    });
    expect(result.succeeded).toHaveLength(0);
    expect(result.deferred).toHaveLength(1);
    expect(result.deferred[0].localPath).toBe("active.md");
    // 로컬에 다운로드되지 않음
    expect(fs.has("active.md")).toBe(false);
  });

  test("conflict: 활성 파일 → deferred로 건너뜀", async () => {
    await fs.write("editing.md", new TextEncoder().encode("local"));
    await remote.upload("editing.md", new TextEncoder().encode("remote"));

    const plan = mkPlan({
      pathLower: "editing.md",
      localPath: "editing.md",
      action: {
        type: "conflict",
        localHash: "lh",
        remoteHash: "rh",
      },
    });

    const result = await executePlan(plan, deps, {
      isFileActive: (path) => path === "editing.md",
    });
    expect(result.deferred).toHaveLength(1);
    expect(await findConflictSibling(fs, "editing.md")).toBeUndefined();
  });

  test("upload: 활성 파일이어도 정상 업로드", async () => {
    await fs.write("active.md", new TextEncoder().encode("local"));
    const plan = mkPlan({
      pathLower: "active.md",
      localPath: "active.md",
      action: { type: "upload", reason: "local_modified" },
    });

    const result = await executePlan(plan, deps, {
      isFileActive: (path) => path === "active.md",
    });
    expect(result.succeeded).toHaveLength(1);
    expect(result.deferred).toHaveLength(0);
  });

  test("isFileActive 없으면 모두 정상 실행", async () => {
    await remote.upload("file.md", new TextEncoder().encode("remote"));
    const plan = mkPlan({
      pathLower: "file.md",
      localPath: "file.md",
      action: { type: "download", reason: "new_remote" },
    });

    const result = await executePlan(plan, deps);
    expect(result.succeeded).toHaveLength(1);
    expect(result.deferred).toHaveLength(0);
  });

  test("DeferralTracker: within bound defers; past bound applies", async () => {
    const { DeferralTracker } = await import("@/sync/deferral-tracker");
    await remote.upload("bound.md", new TextEncoder().encode("remote"));
    const plan = mkPlan({
      pathLower: "bound.md",
      localPath: "bound.md",
      action: { type: "download", reason: "new_remote" },
    });

    const within = new DeferralTracker(60_000);
    const stillDeferred = await executePlan(plan, deps, {
      isFileActive: () => true,
      deferralTracker: within,
    });
    expect(stillDeferred.deferred).toHaveLength(1);
    expect(fs.has("bound.md")).toBe(false);

    const expired = new DeferralTracker(1);
    expired.markDeferred("bound.md", Date.now() - 10);
    const applied = await executePlan(plan, deps, {
      isFileActive: () => true,
      deferralTracker: expired,
    });
    expect(applied.deferred).toHaveLength(0);
    expect(applied.succeeded).toHaveLength(1);
    expect(fs.has("bound.md")).toBe(true);
  });

  test("reloadOpenFile called after successful download, not when deferred", async () => {
    await remote.upload("reload.md", new TextEncoder().encode("remote"));
    const plan = mkPlan({
      pathLower: "reload.md",
      localPath: "reload.md",
      action: { type: "download", reason: "new_remote" },
    });

    const deferredReloads: string[] = [];
    await executePlan(plan, deps, {
      isFileActive: () => true,
      reloadOpenFile: async (path) => {
        deferredReloads.push(path);
      },
    });
    expect(deferredReloads).toEqual([]);

    const reloads: string[] = [];
    await executePlan(plan, deps, {
      reloadOpenFile: async (path) => {
        reloads.push(path);
      },
    });
    expect(reloads).toEqual(["reload.md"]);
  });

  test("혼합: 활성+비활성 파일 동시 처리", async () => {
    await remote.upload("active.md", new TextEncoder().encode("remote1"));
    await remote.upload("other.md", new TextEncoder().encode("remote2"));

    const plan = mkPlan(
      {
        pathLower: "active.md",
        localPath: "active.md",
        action: { type: "download", reason: "new_remote" },
      },
      {
        pathLower: "other.md",
        localPath: "other.md",
        action: { type: "download", reason: "new_remote" },
      },
    );

    const result = await executePlan(plan, deps, {
      isFileActive: (path) => path === "active.md",
    });
    expect(result.succeeded).toHaveLength(1);
    expect(result.deferred).toHaveLength(1);
    expect(fs.has("other.md")).toBe(true);
    expect(fs.has("active.md")).toBe(false);
  });

  // ── 병렬 실행 ──

  test("concurrency=3: 결과가 순차 실행과 동일", async () => {
    for (let i = 0; i < 10; i++) {
      await fs.write(`file-${i}.md`, new TextEncoder().encode(`content ${i}`));
    }

    const items: SyncPlanItem[] = Array.from({ length: 10 }, (_, i) => ({
      pathLower: `file-${i}.md`,
      localPath: `file-${i}.md`,
      action: { type: "upload" as const, reason: "new_local" },
    }));
    const plan = mkPlan(...items);

    const result = await executePlan(plan, deps, { concurrency: 3 });
    expect(result.succeeded).toHaveLength(10);
    expect(result.failed).toHaveLength(0);

    // 모두 원격에 업로드됨
    for (let i = 0; i < 10; i++) {
      expect(remote.has(`file-${i}.md`)).toBe(true);
    }
  });

  test("onProgress 콜백: 완료 횟수 추적", async () => {
    for (let i = 0; i < 5; i++) {
      await fs.write(`f${i}.md`, new TextEncoder().encode(`c${i}`));
    }

    const items: SyncPlanItem[] = Array.from({ length: 5 }, (_, i) => ({
      pathLower: `f${i}.md`,
      localPath: `f${i}.md`,
      action: { type: "upload" as const, reason: "new" },
    }));

    const progress: [number, number][] = [];
    await executePlan(mkPlan(...items), deps, {
      concurrency: 2,
      onProgress: (completed, total) => progress.push([completed, total]),
    });

    expect(progress).toHaveLength(6); // seed 0/N then one bump per item
    expect(progress[0]).toEqual([0, 5]);
    expect(progress[progress.length - 1]).toEqual([5, 5]);
    // total은 항상 5
    expect(progress.every(([, t]) => t === 5)).toBe(true);
  });

  test("concurrency=1: 기본값, 순차 실행과 동일", async () => {
    await fs.write("a.md", new TextEncoder().encode("a"));
    await fs.write("b.md", new TextEncoder().encode("b"));

    const plan = mkPlan(
      { pathLower: "a.md", localPath: "a.md", action: { type: "upload", reason: "new" } },
      { pathLower: "b.md", localPath: "b.md", action: { type: "upload", reason: "new" } },
    );

    const result = await executePlan(plan, deps); // concurrency 미지정 = 1
    expect(result.succeeded).toHaveLength(2);
  });

  test("병렬 실행 중 일부 실패해도 나머지 계속", async () => {
    await fs.write("ok.md", new TextEncoder().encode("ok"));
    // bad.md는 로컬에 없어서 upload 시 실패

    const plan = mkPlan(
      { pathLower: "ok.md", localPath: "ok.md", action: { type: "upload", reason: "new" } },
      { pathLower: "bad.md", localPath: "bad.md", action: { type: "upload", reason: "new" } },
    );

    const result = await executePlan(plan, deps, { concurrency: 2 });
    expect(result.succeeded).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
  });

  // ── conflict: manual 전략 ──

  test("conflict manual: 사용자가 local 선택 → remote canonical + local conflict copy", async () => {
    const localData = new TextEncoder().encode("local version");
    const remoteData = new TextEncoder().encode("remote version");

    await fs.write("test.md", localData);
    await remote.upload("test.md", remoteData);

    const plan = mkPlan({
      pathLower: "test.md",
      localPath: "test.md",
      action: {
        type: "conflict",
        localHash: await dropboxContentHash(localData),
        remoteHash: await dropboxContentHash(remoteData),
      },
    });

    const result = await executePlan(plan, deps, {
      conflictStrategy: "manual",
      conflictResolver: async () => "local",
    });
    expect(result.succeeded).toHaveLength(1);

    expect(await fs.read("test.md")).toEqual(remoteData);
    const conflictPath = await findConflictSibling(fs, "test.md");
    expect(conflictPath).toBeDefined();
    expect(await fs.read(conflictPath!)).toEqual(localData);
    const dl = await remote.download("test.md");
    expect(dl.data).toEqual(remoteData);
  });

  test("conflict manual: 사용자가 remote 선택 → remote canonical + local conflict copy", async () => {
    const localData = new TextEncoder().encode("local version");
    const remoteData = new TextEncoder().encode("remote version");

    await fs.write("test.md", localData);
    await remote.upload("test.md", remoteData);

    const plan = mkPlan({
      pathLower: "test.md",
      localPath: "test.md",
      action: {
        type: "conflict",
        localHash: await dropboxContentHash(localData),
        remoteHash: await dropboxContentHash(remoteData),
      },
    });

    const result = await executePlan(plan, deps, {
      conflictStrategy: "manual",
      conflictResolver: async () => "remote",
    });
    expect(result.succeeded).toHaveLength(1);

    expect(await fs.read("test.md")).toEqual(remoteData);
    const conflictPath = await findConflictSibling(fs, "test.md");
    expect(conflictPath).toBeDefined();
    expect(await fs.read(conflictPath!)).toEqual(localData);
  });

  test("conflict manual: resolver 없으면 keep_both fallback", async () => {
    const localData = new TextEncoder().encode("local version");
    const remoteData = new TextEncoder().encode("remote version");

    await fs.write("test.md", localData);
    await remote.upload("test.md", remoteData);

    const plan = mkPlan({
      pathLower: "test.md",
      localPath: "test.md",
      action: {
        type: "conflict",
        localHash: await dropboxContentHash(localData),
        remoteHash: await dropboxContentHash(remoteData),
      },
    });

    const result = await executePlan(plan, deps, {
      conflictStrategy: "manual",
      // conflictResolver 없음
    });
    expect(result.succeeded).toHaveLength(1);

    // keep_both fallback → conflict 파일 생성
    expect(await findConflictSibling(fs, "test.md")).toBeDefined();
  });

  test("upload rev 충돌 + keep_both: remote canonical + local conflict copy", async () => {
    const remoteData = new TextEncoder().encode("remote version");
    await remote.upload("test.md", remoteData);

    const localData = new TextEncoder().encode("local version");
    await fs.write("test.md", localData, Date.now() + 10000);

    await store.setEntry({
      pathLower: "test.md",
      localPath: "test.md",
      baseLocalHash: "old",
      baseRemoteHash: "old",
      rev: "wrong_rev",
      lastSynced: 1000,
    });

    const plan = mkPlan({
      pathLower: "test.md",
      localPath: "test.md",
      action: { type: "upload", reason: "local_modified" },
    });

    const result = await executePlan(plan, deps, {
      conflictStrategy: "keep_both",
    });
    expect(result.succeeded).toHaveLength(1);
    expect(await fs.read("test.md")).toEqual(remoteData);
    const conflictPath = await findConflictSibling(fs, "test.md");
    expect(conflictPath).toBeDefined();
    expect(await fs.read(conflictPath!)).toEqual(localData);
    const dl = await remote.download("test.md");
    expect(dl.data).toEqual(remoteData);
  });

  test("upload rev 충돌 + manual: resolver로 위임 (remote 선택)", async () => {
    const remoteData = new TextEncoder().encode("remote version");
    await remote.upload("test.md", remoteData);

    const localData = new TextEncoder().encode("local version");
    await fs.write("test.md", localData);

    await store.setEntry({
      pathLower: "test.md",
      localPath: "test.md",
      baseLocalHash: "old",
      baseRemoteHash: "old",
      rev: "wrong_rev",
      lastSynced: 1000,
    });

    const plan = mkPlan({
      pathLower: "test.md",
      localPath: "test.md",
      action: { type: "upload", reason: "local_modified" },
    });

    const result = await executePlan(plan, deps, {
      conflictStrategy: "manual",
      conflictResolver: async () => "remote",
    });
    expect(result.succeeded).toHaveLength(1);
    expect(await fs.read("test.md")).toEqual(remoteData);
    const conflictPath = await findConflictSibling(fs, "test.md");
    expect(conflictPath).toBeDefined();
    expect(await fs.read(conflictPath!)).toEqual(localData);
  });

  test("upload rev 충돌 + manual: merged 결과를 conflict copy로", async () => {
    const remoteData = new TextEncoder().encode("remote version");
    await remote.upload("test.md", remoteData);

    const localData = new TextEncoder().encode("local version");
    await fs.write("test.md", localData);

    await store.setEntry({
      pathLower: "test.md",
      localPath: "test.md",
      baseLocalHash: "old",
      baseRemoteHash: "old",
      rev: "wrong_rev",
      lastSynced: 1000,
    });

    const merged = new TextEncoder().encode("merged content");
    const plan = mkPlan({
      pathLower: "test.md",
      localPath: "test.md",
      action: { type: "upload", reason: "local_modified" },
    });

    const result = await executePlan(plan, deps, {
      conflictStrategy: "manual",
      conflictResolver: async () => ({ type: "merged", content: merged }),
    });
    expect(result.succeeded).toHaveLength(1);
    expect(await fs.read("test.md")).toEqual(remoteData);
    const conflictPath = await findConflictSibling(fs, "test.md");
    expect(conflictPath).toBeDefined();
    expect(await fs.read(conflictPath!)).toEqual(merged);
    const dl = await remote.download("test.md");
    expect(dl.data).toEqual(remoteData);
  });

  test("conflict manual: 사용자 취소(null) → keep_both fallback", async () => {
    const localData = new TextEncoder().encode("local version");
    const remoteData = new TextEncoder().encode("remote version");

    await fs.write("test.md", localData);
    await remote.upload("test.md", remoteData);

    const plan = mkPlan({
      pathLower: "test.md",
      localPath: "test.md",
      action: {
        type: "conflict",
        localHash: await dropboxContentHash(localData),
        remoteHash: await dropboxContentHash(remoteData),
      },
    });

    const result = await executePlan(plan, deps, {
      conflictStrategy: "manual",
      conflictResolver: async () => null,
    });
    expect(result.succeeded).toHaveLength(1);
    expect(result.deferred).toHaveLength(0);

    expect(await findConflictSibling(fs, "test.md")).toBeDefined();
    expect(await fs.read("test.md")).toEqual(remoteData);
  });

  test("recordBase + download in one plan both execute", async () => {
    await remote.upload("b.md", new TextEncoder().encode("B"));
    await fs.write("a.md", new TextEncoder().encode("A"));

    const hashA = await dropboxContentHash(new TextEncoder().encode("A"));
    const hashB = await dropboxContentHash(new TextEncoder().encode("B"));

    const plan: SyncPlan = {
      items: [
        {
          pathLower: "a.md",
          localPath: "a.md",
          action: {
            type: "recordBase",
            reason: "same_content",
            localHash: hashA,
            remoteHash: hashA,
            rev: "rev_1",
            pathDisplay: "a.md",
          },
        },
        {
          pathLower: "b.md",
          localPath: "b.md",
          action: { type: "download", reason: "new_remote" },
        },
      ],
      stats: {
        ...emptySyncPlanStats(),
        download: 1,
        recordBase: 1,
      },
    };

    const result = await executePlan(plan, deps);
    expect(result.succeeded.some((i) => i.localPath === "b.md")).toBe(true);
    expect(fs.has("b.md")).toBe(true);
  });

  test("conflict: reuses existing device conflict copy on repeat clash", async () => {
    const existingCopy = "test (Device test's conflicted copy 2026-07-26).md";
    const localData = new TextEncoder().encode("local version");
    const remoteData = new TextEncoder().encode("remote version");

    await fs.write("test.md", localData);
    await fs.write(existingCopy, new TextEncoder().encode("old copy"));
    await remote.upload("test.md", remoteData);

    const plan = mkPlan({
      pathLower: "test.md",
      localPath: "test.md",
      action: {
        type: "conflict",
        localHash: await dropboxContentHash(localData),
        remoteHash: await dropboxContentHash(remoteData),
      },
    });

    await executePlan(plan, deps);
    expect(await findConflictSibling(fs, "test.md")).toBe(existingCopy);
    expect(await fs.read(existingCopy)).toEqual(localData);
  });
});

// ── makeConflictPath ──

describe("makeConflictPath", () => {
  test("확장자가 있는 파일", () => {
    expect(makeConflictPath("test.md", [], {
      deviceLabel: "Device test",
      now: new Date("2026-07-26T12:00:00Z"),
    })).toBe("test (Device test's conflicted copy 2026-07-26).md");
  });

  test("경로가 있는 파일", () => {
    expect(makeConflictPath("notes/doc.md", [], {
      deviceLabel: "Device test",
      now: new Date("2026-07-26T12:00:00Z"),
    })).toBe("notes/doc (Device test's conflicted copy 2026-07-26).md");
  });

  test("확장자 없는 파일", () => {
    expect(makeConflictPath("README", [], {
      deviceLabel: "Device test",
      now: new Date("2026-07-26T12:00:00Z"),
    })).toBe("README (Device test's conflicted copy 2026-07-26)");
  });

  test("여러 점이 있는 파일", () => {
    expect(makeConflictPath("my.file.name.md", [], {
      deviceLabel: "Device test",
      now: new Date("2026-07-26T12:00:00Z"),
    })).toBe("my.file.name (Device test's conflicted copy 2026-07-26).md");
  });
});
