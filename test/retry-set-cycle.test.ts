import { describe, test, expect, beforeEach } from "bun:test";
import {
  MemoryFileSystem,
  MemoryRemoteStorage,
  MemoryStateStore,
} from "@/adapters/memory";
import { SyncEngine } from "@/sync/engine";
import { executePlan } from "@/sync/executor";
import { FailingRemoteStorage } from "./support/failing-remote";
import {
  mergeRetryItemsIntoPlan,
  parseRetrySet,
  serializeRetrySet,
  RETRY_SET_META_KEY,
  type RetrySetEntry,
} from "@/sync/retry-set";
import { isPathInSections } from "@/sync/sync-scope";
import { emptySyncPlanStats } from "@/types";

const CONFIG_DIR = ".obsidian";

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

  test("notes retries are not merged into a settings-only cycle", async () => {
    // Durable global retry set still holds note failures after a notes section cycle.
    const notesRetry: RetrySetEntry[] = [
      {
        pathLower: "note.md",
        localPath: "note.md",
        action: { type: "upload", reason: "new_local" },
        addedAt: Date.now(),
      },
    ];
    await store.setMeta(RETRY_SET_META_KEY, serializeRetrySet(notesRetry));
    await fs.write("note.md", new TextEncoder().encode("local"));

    // Same gate the engine uses before mergeRetryItemsIntoPlan.
    const settingsScoped = notesRetry.filter((entry) =>
      isPathInSections(entry.localPath, ["settings"], CONFIG_DIR, []),
    );
    expect(mergeRetryItemsIntoPlan([], settingsScoped)).toHaveLength(0);

    engine.setSyncSections(["settings"], CONFIG_DIR);
    const settingsCycle = await engine.runCycle();
    // Settings section must not re-execute the notes upload from the global retry set.
    expect(
      settingsCycle.plan.items.some((item) => item.pathLower === "note.md"),
    ).toBe(false);
    // Notes failure remains durable for a later notes cycle.
    const stillQueued = parseRetrySet(await store.getMeta(RETRY_SET_META_KEY));
    expect(stillQueued.some((entry) => entry.pathLower === "note.md")).toBe(true);
  });
});
