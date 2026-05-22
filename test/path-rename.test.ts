import { describe, test, expect, beforeEach } from "bun:test";
import {
  MemoryFileSystem,
  MemoryRemoteStorage,
  MemoryStateStore,
} from "@/adapters/memory";
import { applyPathRenames } from "@/sync/path-rename";

describe("applyPathRenames", () => {
  let fs: MemoryFileSystem;
  let remote: MemoryRemoteStorage;
  let store: MemoryStateStore;

  beforeEach(() => {
    fs = new MemoryFileSystem();
    remote = new MemoryRemoteStorage();
    store = new MemoryStateStore();
  });

  test("renames remote, local, and sync state", async () => {
    const data = new TextEncoder().encode("hello");
    await remote.upload("old:name.md", data);
    await fs.write("old:name.md", data);

    await store.setEntry({
      pathLower: "old:name.md",
      localPath: "old:name.md",
      baseLocalHash: "h1",
      baseRemoteHash: "h1",
      rev: "rev_1",
      lastSynced: Date.now(),
    });

    await applyPathRenames(fs, remote, store, [
      { from: "old:name.md", to: "old-name.md" },
    ]);

    expect(remote.has("old-name.md")).toBe(true);
    expect(fs.has("old-name.md")).toBe(true);
    expect(await store.getEntry("old:name.md")).toBeNull();
    const entry = await store.getEntry("old-name.md");
    expect(entry?.localPath).toBe("old-name.md");
  });
});
