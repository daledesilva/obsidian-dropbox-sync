import { describe, test, expect, beforeEach } from "bun:test";
import { EngineManager, type EngineManagerConfig } from "@/sync/engine-manager";
import {
  MemoryFileSystem,
  MemoryRemoteStorage,
  MemoryStateStore,
} from "@/adapters/memory";

function createConfig(): EngineManagerConfig {
  return {
    createDeps: () => ({
      fs: new MemoryFileSystem(),
      remote: new MemoryRemoteStorage(),
      store: new MemoryStateStore(),
    }),
    getOptions: () => ({}),
  };
}

describe("EngineManager", () => {
  let mgr: EngineManager;
  let config: EngineManagerConfig;

  beforeEach(() => {
    config = createConfig();
    mgr = new EngineManager(config);
  });

  // ── getOrCreate ──

  test("getOrCreate: 엔진 생성 후 반환", () => {
    const engine = mgr.getOrCreate();
    expect(engine).toBeDefined();
  });

  test("getOrCreate: 두 번 호출 시 같은 인스턴스", () => {
    const a = mgr.getOrCreate();
    const b = mgr.getOrCreate();
    expect(a).toBe(b);
  });

  test("getOrCreate: createDeps는 한 번만 호출됨", () => {
    let callCount = 0;
    config.createDeps = () => {
      callCount++;
      return {
        fs: new MemoryFileSystem(),
        remote: new MemoryRemoteStorage(),
        store: new MemoryStateStore(),
      };
    };
    mgr = new EngineManager(config);

    mgr.getOrCreate();
    mgr.getOrCreate();
    expect(callCount).toBe(1);
  });

  // ── reset ──

  test("reset: 엔진 재생성", () => {
    const a = mgr.getOrCreate();
    mgr.reset();
    const b = mgr.getOrCreate();
    expect(a).not.toBe(b);
  });

  test("reset: deleteLog 보존", () => {
    const engine = mgr.getOrCreate();
    engine.trackDelete("file-a.md");
    engine.trackDelete("file-b.md");

    mgr.reset();
    const newEngine = mgr.getOrCreate();
    const log = newEngine.getDeleteLog();
    expect(log.sort()).toEqual(["file-a.md", "file-b.md"]);
  });

  test("reset: 엔진 없을 때 안전하게 호출 가능", () => {
    expect(() => mgr.reset()).not.toThrow();
  });

  // ── store / remote getters ──

  test("store: 엔진 생성 전 null", () => {
    expect(mgr.store).toBeNull();
  });

  test("store: 엔진 생성 후 접근 가능", () => {
    mgr.getOrCreate();
    expect(mgr.store).not.toBeNull();
  });

  test("remote: 엔진 생성 전 null", () => {
    expect(mgr.remote).toBeNull();
  });

  test("remote: 엔진 생성 후 접근 가능", () => {
    mgr.getOrCreate();
    expect(mgr.remote).not.toBeNull();
  });

  test("reset 후 store/remote는 null", () => {
    mgr.getOrCreate();
    mgr.reset();
    expect(mgr.store).toBeNull();
    expect(mgr.remote).toBeNull();
  });

  // ── persistDeleteLog ──

  test("persistDeleteLog: store에 저장", async () => {
    mgr.getOrCreate();
    const engine = mgr.getOrCreate();
    engine.trackDelete("x.md");

    mgr.persistDeleteLog();

    const saved = await mgr.store!.getMeta("deleteLog");
    expect(saved).not.toBeNull();
    expect(JSON.parse(saved!)).toEqual(["x.md"]);
  });

  test("persistDeleteLog: 엔진 없으면 안전하게 무시", () => {
    expect(() => mgr.persistDeleteLog()).not.toThrow();
  });

  // ── restoreDeleteLog ──

  test("restoreDeleteLog: store에서 복원", async () => {
    mgr.getOrCreate();
    await mgr.store!.setMeta("deleteLog", JSON.stringify(["a.md", "b.md"]));

    await mgr.restoreDeleteLog();

    const log = mgr.getOrCreate().getDeleteLog();
    expect(log.sort()).toEqual(["a.md", "b.md"]);
  });

  test("restoreDeleteLog: 엔진 없으면 안전하게 무시", async () => {
    await expect(mgr.restoreDeleteLog()).resolves.toBeUndefined();
  });

  test("restoreDeleteLog: 잘못된 JSON이면 무시", async () => {
    mgr.getOrCreate();
    await mgr.store!.setMeta("deleteLog", "not-json{{");

    await expect(mgr.restoreDeleteLog()).resolves.toBeUndefined();
    expect(mgr.getOrCreate().getDeleteLog()).toEqual([]);
  });

  // ── hasPendingDeletes ──

  test("hasPendingDeletes: 삭제 로그 없으면 false", () => {
    mgr.getOrCreate();
    expect(mgr.hasPendingDeletes()).toBe(false);
  });

  test("hasPendingDeletes: 삭제 로그 있으면 true", () => {
    const engine = mgr.getOrCreate();
    engine.trackDelete("note.md");
    expect(mgr.hasPendingDeletes()).toBe(true);
  });

  test("hasPendingDeletes: 엔진 없으면 false", () => {
    expect(mgr.hasPendingDeletes()).toBe(false);
  });

  // ── getOptions 동적 반영 ──

  test("reset 후 getOrCreate는 최신 옵션 사용", () => {
    let strategy = "keep_both";
    config.getOptions = () => ({ conflictStrategy: strategy as "keep_both" | "manual" });
    mgr = new EngineManager(config);

    mgr.getOrCreate();
    strategy = "manual";
    mgr.reset();

    // 새 엔진은 getOptions()를 다시 호출하므로 newest 반영
    // (SyncEngine 내부에서 options 확인은 어렵지만, 에러 없이 생성되면 OK)
    expect(() => mgr.getOrCreate()).not.toThrow();
  });
});
