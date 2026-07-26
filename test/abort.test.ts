import { describe, test, expect, beforeEach } from "bun:test";
import { executePlan } from "@/sync/executor";
import type { ExecutorDeps } from "@/sync/executor";
import {
  MemoryFileSystem,
  MemoryRemoteStorage,
  MemoryStateStore,
} from "@/adapters/memory";
import type { SyncPlan, SyncPlanItem } from "@/types"
import { emptySyncPlanStats } from "@/types";
import { SyncEngine } from "@/sync/engine";

function mkPlan(...items: SyncPlanItem[]): SyncPlan {
  const stats = emptySyncPlanStats();
  for (const item of items) {
    const key = item.action.type;
    if (key in stats) (stats as Record<string, number>)[key]++;
  }
  return { items, stats };
}

describe("AbortSignal", () => {
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

  test("executor: 이미 aborted인 signal → 아무 항목도 실행하지 않음", async () => {
    await fs.write("a.md", new TextEncoder().encode("a"));
    await fs.write("b.md", new TextEncoder().encode("b"));

    const controller = new AbortController();
    controller.abort();

    const plan = mkPlan(
      { pathLower: "a.md", localPath: "a.md", action: { type: "upload", reason: "new" } },
      { pathLower: "b.md", localPath: "b.md", action: { type: "upload", reason: "new" } },
    );

    const result = await executePlan(plan, deps, { signal: controller.signal });
    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  test("executor: 첫 항목 후 abort → 나머지 건너뜀", async () => {
    await fs.write("a.md", new TextEncoder().encode("a"));
    await fs.write("b.md", new TextEncoder().encode("b"));

    const controller = new AbortController();

    // a.md upload은 성공, 그 후 abort
    const originalUpload = remote.upload.bind(remote);
    let uploadCount = 0;
    remote.upload = async (...args: Parameters<typeof remote.upload>) => {
      uploadCount++;
      const result = await originalUpload(...args);
      if (uploadCount === 1) controller.abort();
      return result;
    };

    const plan = mkPlan(
      { pathLower: "a.md", localPath: "a.md", action: { type: "upload", reason: "new" } },
      { pathLower: "b.md", localPath: "b.md", action: { type: "upload", reason: "new" } },
    );

    const result = await executePlan(plan, deps, { signal: controller.signal });
    expect(result.succeeded).toHaveLength(1);
    expect(result.succeeded[0].localPath).toBe("a.md");
    expect(remote.has("b.md")).toBe(false);
  });

  test("engine: aborted signal → throwIfAborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const engine = new SyncEngine({ fs, remote, store });
    await expect(engine.runCycle(controller.signal)).rejects.toThrow();
  });
});
