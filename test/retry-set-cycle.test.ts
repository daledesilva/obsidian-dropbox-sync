import { describe, test, expect, beforeEach } from "bun:test";
import {
  MemoryFileSystem,
  MemoryRemoteStorage,
  MemoryStateStore,
} from "@/adapters/memory";
import { SyncEngine } from "@/sync/engine";
import { executePlan } from "@/sync/executor";
import { FailingRemoteStorage } from "./support/failing-remote";
import { parseRetrySet, RETRY_SET_META_KEY } from "@/sync/retry-set";
import { emptySyncPlanStats } from "@/types";

describe("retry set after cursor checkpoint (G27)", () => {
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
      { concurrency: 1 },
    );
  });

  test("failed download is retried from retry set after cursor advances", async () => {
    await realRemote.upload("a.md", new TextEncoder().encode("A"));
    await realRemote.upload("b.md", new TextEncoder().encode("B"));

    failingRemote.injectFailure({ after: 1, method: "download" });

    const result1 = await engine.runCycle();
    expect(result1.result.failed.length).toBeGreaterThanOrEqual(1);
    expect(result1.cursorUpdated).toBe(true);
    expect(fs.has("a.md")).toBe(true);

    const retryAfterFail = parseRetrySet(await store.getMeta(RETRY_SET_META_KEY));
    expect(retryAfterFail.some((entry) => entry.localPath === "b.md")).toBe(true);

    failingRemote.clearFailure();
    const retryPlan = {
      items: retryAfterFail.map((entry) => ({
        pathLower: entry.pathLower,
        localPath: entry.localPath,
        action: entry.action,
      })),
      stats: {
        ...emptySyncPlanStats(),
        download: retryAfterFail.filter((e) => e.action.type === "download").length,
      },
    };
    const retryResult = await executePlan(retryPlan, { fs, remote: failingRemote, store });
    expect(retryResult.failed).toHaveLength(0);
    expect(fs.has("b.md")).toBe(true);
  });
});
