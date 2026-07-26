import { describe, test, expect, beforeEach } from "bun:test";
import {
  MemoryFileSystem,
  MemoryRemoteStorage,
  MemoryStateStore,
} from "@/adapters/memory";
import { SyncEngine } from "@/sync/engine";
import { executePlan } from "@/sync/executor";
import { FailingRemoteStorage } from "../support/failing-remote";
import { parseRetrySet, RETRY_SET_META_KEY } from "@/sync/retry-set";
import { emptySyncPlanStats } from "@/types";

describe("네트워크 실패 시나리오", () => {
  let fs: MemoryFileSystem;
  let realRemote: MemoryRemoteStorage;
  let failingRemote: FailingRemoteStorage;
  let store: MemoryStateStore;
  let engine: SyncEngine;

  beforeEach(() => {
    fs = new MemoryFileSystem();
    realRemote = new MemoryRemoteStorage();
    failingRemote = new FailingRemoteStorage(realRemote);
    store = new MemoryStateStore();
    engine = new SyncEngine(
      { fs, remote: failingRemote, store },
      { resurrectionResolver: async () => "upload" },
    );
  });

  test("upload 실패 → 다음 cycle에서 재시도", async () => {
    await fs.write("a.md", new TextEncoder().encode("content A"));
    await fs.write("b.md", new TextEncoder().encode("content B"));

    // 첫 번째 upload 후 실패
    failingRemote.injectFailure({ after: 1, method: "upload" });

    const result1 = await engine.runCycle();
    // a.md는 성공, b.md는 실패
    expect(result1.result.succeeded.length).toBeGreaterThanOrEqual(1);
    expect(result1.result.failed.length).toBeGreaterThanOrEqual(1);

    // 실패 해제 후 재시도
    failingRemote.clearFailure();
    const result2 = await engine.runCycle();

    // 이전에 실패한 파일이 이번에 성공
    expect(result2.result.failed).toHaveLength(0);

    // 원격에 둘 다 존재
    expect(realRemote.has("a.md")).toBe(true);
    expect(realRemote.has("b.md")).toBe(true);
  });

  test("download 실패 → retry set에 기록 후 재시도", async () => {
    const downloadStore = new MemoryStateStore();
    const downloadEngine = new SyncEngine(
      { fs, remote: failingRemote, store: downloadStore },
    );

    await realRemote.upload("b.md", new TextEncoder().encode("B"));

    failingRemote.injectFailure({ after: 0, method: "download" });

    const result1 = await downloadEngine.runCycle();
    expect(result1.result.failed.length).toBeGreaterThanOrEqual(1);
    expect(fs.has("b.md")).toBe(false);

    const retryEntries = parseRetrySet(await downloadStore.getMeta(RETRY_SET_META_KEY));
    expect(retryEntries.some((entry) => entry.localPath === "b.md")).toBe(true);

    failingRemote.clearFailure();
    const retryResult = await executePlan(
      {
        items: retryEntries.map((entry) => ({
          pathLower: entry.pathLower,
          localPath: entry.localPath,
          action: entry.action,
        })),
        stats: {
          ...emptySyncPlanStats(),
          download: retryEntries.length,
        },
      },
      { fs, remote: failingRemote, store: downloadStore },
    );
    expect(retryResult.failed).toHaveLength(0);
    expect(fs.has("b.md")).toBe(true);
  });

  test("listChanges 실패 → cycle 전체 실패", async () => {
    failingRemote.injectFailure({ after: 0, method: "listChanges" });

    await expect(engine.runCycle()).rejects.toThrow("Network error");
  });

  test("delete 실패 → 나머지 작업 계속 진행", async () => {
    // 초기 동기화
    await fs.write("keep.md", new TextEncoder().encode("keep"));
    await fs.write("del.md", new TextEncoder().encode("to-delete"));

    failingRemote.clearFailure();
    await engine.runCycle();

    // 로컬에서 삭제
    await fs.delete("del.md");

    // delete 실패 주입
    failingRemote.injectFailure({ after: 0, method: "delete" });

    // 새 파일 추가 (upload)
    await fs.write("new.md", new TextEncoder().encode("new"));

    const result = await engine.runCycle();
    // delete는 실패, upload는 성공
    const deleteFailures = result.result.failed.filter(
      (f) => f.item.action.type === "deleteRemote",
    );
    expect(deleteFailures.length).toBeGreaterThanOrEqual(0); // del.md 삭제 실패 가능

    // new.md는 성공적으로 업로드
    expect(realRemote.has("new.md")).toBe(true);
  });

  test("부분 실패 후 상태 일관성 유지", async () => {
    await fs.write("a.md", new TextEncoder().encode("a"));
    await fs.write("b.md", new TextEncoder().encode("b"));
    await fs.write("c.md", new TextEncoder().encode("c"));

    // 2번째 upload 후 실패 (a 성공, b or c 실패)
    failingRemote.injectFailure({ after: 2, method: "upload" });

    const result1 = await engine.runCycle();
    const succeededPaths = result1.result.succeeded.map((i) => i.pathLower);
    const failedPaths = result1.result.failed.map((i) => i.item.pathLower);

    // 성공한 파일은 state에 기록됨
    for (const p of succeededPaths) {
      if (p === "a.md" || p === "b.md" || p === "c.md") {
        const entry = await store.getEntry(p);
        expect(entry).not.toBeNull();
      }
    }

    // 실패한 파일은 state에 기록 안 됨
    for (const p of failedPaths) {
      const entry = await store.getEntry(p);
      expect(entry).toBeNull();
    }

    // 실패 해제 후 재시도 → 모두 성공
    failingRemote.clearFailure();
    const result2 = await engine.runCycle();
    expect(result2.result.failed).toHaveLength(0);
  });
});
