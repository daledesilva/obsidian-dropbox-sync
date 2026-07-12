import { describe, test, expect } from "bun:test";
import { VaultAdapter, isFolderAlreadyExistsError } from "@/adapters/vault-adapter";

describe("isFolderAlreadyExistsError", () => {
  test("matches Obsidian createFolder race message", () => {
    expect(isFolderAlreadyExistsError(new Error("Folder already exists."))).toBe(true);
    expect(isFolderAlreadyExistsError(new Error("something else"))).toBe(false);
  });
});

describe("VaultAdapter write / ensureParentDir", () => {
  test("ignores Folder already exists when vault index lags (parallel download race)", async () => {
    const onDiskFolders = new Set<string>([".obsidian", ".obsidian/plugins"]);
    const indexedFolders = new Set<string>([".obsidian", ".obsidian/plugins"]);
    const files = new Map<string, ArrayBuffer>();
    const raceFolder = ".obsidian/plugins/obsidian-icon-folder/icons/tabler-icons";
    // Another parallel download created this folder on disk; index not updated yet.
    onDiskFolders.add(raceFolder);

    const vault = {
      getFiles: () => [],
      readBinary: async () => new ArrayBuffer(0),
      getAbstractFileByPath: (path: string) => {
        if (files.has(path)) {
          return { stat: { mtime: 0, size: 0 }, extension: "svg" };
        }
        if (indexedFolders.has(path)) return { children: {} };
        return null;
      },
      createFolder: async (path: string) => {
        if (onDiskFolders.has(path)) {
          throw new Error("Folder already exists.");
        }
        onDiskFolders.add(path);
        // Simulate iOS index lag: folder on disk but not visible yet.
      },
      createBinary: async (path: string, data: ArrayBuffer) => {
        files.set(path, data);
      },
      modifyBinary: async () => {},
    };

    const adapter = new VaultAdapter(vault as never, [], {} as never);
    const path = ".obsidian/plugins/obsidian-icon-folder/icons/tabler-icons/CarouselHorizontal.svg";
    const data = new TextEncoder().encode("<svg/>");

    await expect(adapter.write(path, data)).resolves.toBeUndefined();
    expect(onDiskFolders.has(".obsidian/plugins/obsidian-icon-folder")).toBe(true);
    expect(onDiskFolders.has(".obsidian/plugins/obsidian-icon-folder/icons")).toBe(true);
    expect(onDiskFolders.has(".obsidian/plugins/obsidian-icon-folder/icons/tabler-icons")).toBe(true);
    expect(files.has(path)).toBe(true);
  });

  test("parallel writes to the same new parent folder both succeed", async () => {
    const onDiskFolders = new Set<string>([".obsidian", ".obsidian/plugins"]);
    const indexedFolders = new Set<string>([".obsidian", ".obsidian/plugins"]);
    const files = new Map<string, ArrayBuffer>();
    let createFolderCalls = 0;

    const vault = {
      getFiles: () => [],
      readBinary: async () => new ArrayBuffer(0),
      getAbstractFileByPath: (path: string) => {
        if (files.has(path)) {
          return { stat: { mtime: 0, size: 0 }, extension: "svg" };
        }
        if (indexedFolders.has(path)) return { children: {} };
        return null;
      },
      createFolder: async (path: string) => {
        createFolderCalls++;
        if (onDiskFolders.has(path)) {
          throw new Error("Folder already exists.");
        }
        onDiskFolders.add(path);
      },
      createBinary: async (path: string, data: ArrayBuffer) => {
        files.set(path, data);
      },
      modifyBinary: async () => {},
    };

    const adapter = new VaultAdapter(vault as never, [], {} as never);
    const base = ".obsidian/plugins/some-plugin/assets";
    const dataA = new TextEncoder().encode("a");
    const dataB = new TextEncoder().encode("b");

    await Promise.all([
      adapter.write(`${base}/a.svg`, dataA),
      adapter.write(`${base}/b.svg`, dataB),
    ]);

    expect(files.has(`${base}/a.svg`)).toBe(true);
    expect(files.has(`${base}/b.svg`)).toBe(true);
    expect(onDiskFolders.has(base)).toBe(true);
    expect(createFolderCalls).toBeGreaterThan(1);
  });
});
