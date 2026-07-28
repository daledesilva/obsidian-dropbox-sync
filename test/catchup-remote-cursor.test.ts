import { describe, expect, test, beforeEach } from "bun:test";
import {
  MemoryFileSystem,
  MemoryRemoteStorage,
  MemoryStateStore,
} from "@/adapters/memory";
import { SyncEngine } from "@/sync/engine";

describe("catchUpRemoteCursor after remote mutations", () => {
  let fs: MemoryFileSystem;
  let remote: MemoryRemoteStorage;
  let store: MemoryStateStore;

  beforeEach(() => {
    fs = new MemoryFileSystem();
    remote = new MemoryRemoteStorage();
    store = new MemoryStateStore();
  });

  test("after upload, committed cursor equals remote head (no leftover own-write delta)", async () => {
    const engine = new SyncEngine(
      { fs, remote, store },
      {
        concurrency: 1,
        resurrectionResolver: async () => "upload",
      },
    );

    await fs.write("note.md", new TextEncoder().encode("local v1"));
    const result = await engine.runCycle();
    expect(result.result.failed).toHaveLength(0);
    expect(result.cursorUpdated).toBe(true);
    expect(
      result.result.succeeded.some((item) => item.action.type === "upload"),
    ).toBe(true);

    const committed = await store.getMeta("cursor");
    expect(committed).toBeTruthy();

    // Following listChanges from the committed cursor must not re-surface our upload.
    // Without catchUpRemoteCursor, the cycle cursor stops before own writes and
    // longpoll would immediately echo them as peer changes.
    const leftover = await remote.listChanges(committed!);
    expect(leftover.entries.filter((e) => !e.deleted && e.pathLower === "note.md")).toHaveLength(0);
    expect(leftover.hasMore).toBe(false);
  });
});
