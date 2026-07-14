import { describe, test, expect, beforeEach } from "bun:test";
import { executePlan, makeConflictPath } from "@/sync/executor";
import type { ExecutorDeps, ExecutorConfig } from "@/sync/executor";
import {
  MemoryFileSystem,
  MemoryRemoteStorage,
  MemoryStateStore,
} from "@/adapters/memory";
import { dropboxContentHash } from "@/hash";
import type { SyncPlan, SyncPlanItem } from "@/types";
import { PathValidationError } from "@/types";

function mkPlan(...items: SyncPlanItem[]): SyncPlan {
  const stats = {
    upload: 0,
    download: 0,
    deleteLocal: 0,
    deleteRemote: 0,
    conflict: 0,
    noop: 0,
  };
  for (const item of items) {
    const key = item.action.type as keyof typeof stats;
    if (key in stats) stats[key]++;
  }
  return { items, stats };
}

describe("executePlan", () => {
  let fs: MemoryFileSystem;
  let remote: MemoryRemoteStorage;
  let store: MemoryStateStore;
  let deps: ExecutorDeps;

  beforeEach(() => {
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

    // conflict 파일 생성됨
    const conflictPath = fs.findByPrefix("test.conflict-");
    expect(conflictPath).toBeDefined();
    const conflictData = await fs.read(conflictPath!);
    expect(conflictData).toEqual(remoteData);

    // 원본 로컬 파일 유지
    expect(await fs.read("test.md")).toEqual(localData);

    // 원격은 로컬 버전으로 업데이트됨
    const remoteDl = await remote.download("test.md");
    expect(remoteDl.data).toEqual(localData);
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

    // 로컬 원본 유지
    expect(await fs.read("test.md")).toEqual(localData);

    // 원격 버전 conflict 파일로 보존
    const conflictPath = fs.findByPrefix("test.conflict-");
    expect(conflictPath).toBeDefined();
    expect(await fs.read(conflictPath!)).toEqual(remoteData);

    // 원격은 로컬 버전으로 업데이트
    const dl = await remote.download("test.md");
    expect(dl.data).toEqual(localData);

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

  test("noop: 아무것도 하지 않음", async () => {
    const plan = mkPlan({
      pathLower: "test.md",
      localPath: "test.md",
      action: { type: "noop", reason: "same_content" },
    });

    const result = await executePlan(plan, deps);
    expect(result.succeeded).toHaveLength(1);
    expect(store.getEntryCount()).toBe(0);
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
    expect(fs.has("editing.conflict.md")).toBe(false);
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

  // ── conflict: newest 전략 ──

  test("conflict newest: 로컬이 더 최신 → 로컬 유지", async () => {
    const localData = new TextEncoder().encode("local version");
    const remoteData = new TextEncoder().encode("remote version");

    // 로컬 파일 (mtime 더 큼)
    await fs.write("test.md", localData, 2000);
    // 원격 파일 (serverModified 더 작음)
    await remote.upload("test.md", remoteData);
    // MemoryRemoteStorage의 serverModified는 Date.now()로 설정되지만,
    // 우리가 테스트하려면 시간 차이가 필요함. 로컬 mtime이 미래값이면 됨.
    await fs.write("test.md", localData, Date.now() + 10000);

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
      conflictStrategy: "newest",
    });
    expect(result.succeeded).toHaveLength(1);

    // conflict 파일 없어야 함 (newest는 하나만 남김)
    expect(fs.has("test.conflict.md")).toBe(false);
    // 로컬 유지
    expect(await fs.read("test.md")).toEqual(localData);
    // 원격도 로컬 버전으로
    const dl = await remote.download("test.md");
    expect(dl.data).toEqual(localData);
  });

  test("conflict newest: 원격이 더 최신 → 원격 버전으로 덮어쓰기", async () => {
    const localData = new TextEncoder().encode("local version");
    const remoteData = new TextEncoder().encode("remote version");

    // 로컬 파일 (mtime 과거)
    await fs.write("test.md", localData, 100);
    // 원격 파일 (serverModified 더 큼 - Date.now())
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
      conflictStrategy: "newest",
    });
    expect(result.succeeded).toHaveLength(1);

    // 로컬이 원격 버전으로 덮어씌워짐
    expect(await fs.read("test.md")).toEqual(remoteData);
    // conflict 파일 없음
    expect(fs.has("test.conflict.md")).toBe(false);
  });

  // ── conflict: manual 전략 ──

  test("conflict manual: 사용자가 local 선택", async () => {
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

    // 로컬 유지
    expect(await fs.read("test.md")).toEqual(localData);
    // 원격도 로컬 버전
    const dl = await remote.download("test.md");
    expect(dl.data).toEqual(localData);
    // conflict 파일 없음
    expect(fs.has("test.conflict.md")).toBe(false);
  });

  test("conflict manual: 사용자가 remote 선택", async () => {
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

    // 로컬이 원격 버전으로 덮어씌워짐
    expect(await fs.read("test.md")).toEqual(remoteData);
    // conflict 파일 없음
    expect(fs.has("test.conflict.md")).toBe(false);
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
    expect(fs.findByPrefix("test.conflict-")).toBeDefined();
  });

  // ── A1: upload rev 충돌 → strategy별 분기 ──

  test("upload rev 충돌 + newest: 로컬이 최신이면 로컬 유지", async () => {
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
      conflictStrategy: "newest",
    });
    expect(result.succeeded).toHaveLength(1);
    expect(fs.findByPrefix("test.conflict-")).toBeUndefined();
    const dl = await remote.download("test.md");
    expect(dl.data).toEqual(localData);
  });

  test("upload rev 충돌 + newest: 원격이 최신이면 원격으로 덮어쓰기", async () => {
    const remoteData = new TextEncoder().encode("remote version");
    await remote.upload("test.md", remoteData);

    const localData = new TextEncoder().encode("local version");
    await fs.write("test.md", localData, 100);

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
      conflictStrategy: "newest",
    });
    expect(result.succeeded).toHaveLength(1);
    expect(await fs.read("test.md")).toEqual(remoteData);
    expect(fs.findByPrefix("test.conflict-")).toBeUndefined();
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
  });

  test("upload rev 충돌 + manual: merged 결과 적용", async () => {
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
    expect(await fs.read("test.md")).toEqual(merged);
    const dl = await remote.download("test.md");
    expect(dl.data).toEqual(merged);
  });

  // ── A2: stat() 호출 검증 ──

  test("conflict newest: stat()으로 mtime 조회 (list() 미호출)", async () => {
    const localData = new TextEncoder().encode("local");
    const remoteData = new TextEncoder().encode("remote");
    await fs.write("test.md", localData, Date.now() + 10000);
    await remote.upload("test.md", remoteData);

    let statCalled = false;
    const origStat = fs.stat.bind(fs);
    fs.stat = async (path: string) => {
      statCalled = true;
      return origStat(path);
    };

    let listCalled = false;
    const origList = fs.list.bind(fs);
    fs.list = async () => {
      listCalled = true;
      return origList();
    };

    const plan = mkPlan({
      pathLower: "test.md",
      localPath: "test.md",
      action: {
        type: "conflict",
        localHash: await dropboxContentHash(localData),
        remoteHash: await dropboxContentHash(remoteData),
      },
    });

    await executePlan(plan, deps, { conflictStrategy: "newest" });
    expect(statCalled).toBe(true);
    expect(listCalled).toBe(false);
  });

  test("conflict manual: 사용자 취소(null) → skip (다음 싱크에서 재감지)", async () => {
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
    expect(result.succeeded).toHaveLength(0);
    expect(result.deferred).toHaveLength(1);

    // skip → conflict 파일 생성 안 됨, 상태 미갱신, cursor 전진 안 됨
    expect(fs.findByPrefix("test.conflict-")).toBeUndefined();
    // 로컬 파일 그대로
    expect(await fs.read("test.md")).toEqual(localData);
  });
});

// ── makeConflictPath ──

describe("makeConflictPath", () => {
  test("확장자가 있는 파일", () => {
    expect(makeConflictPath("test.md")).toMatch(
      /^test\.conflict-\d{4}-\d{2}-\d{2}T\d{4}\.md$/,
    );
  });

  test("경로가 있는 파일", () => {
    expect(makeConflictPath("notes/doc.md")).toMatch(
      /^notes\/doc\.conflict-\d{4}-\d{2}-\d{2}T\d{4}\.md$/,
    );
  });

  test("확장자 없는 파일", () => {
    expect(makeConflictPath("README")).toMatch(
      /^README\.conflict-\d{4}-\d{2}-\d{2}T\d{4}$/,
    );
  });

  test("여러 점이 있는 파일", () => {
    expect(makeConflictPath("my.file.name.md")).toMatch(
      /^my\.file\.name\.conflict-\d{4}-\d{2}-\d{2}T\d{4}\.md$/,
    );
  });
});
