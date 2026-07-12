import { describe, test, expect } from "bun:test";
import { VaultAdapter, isFolderAlreadyExistsError } from "@/adapters/vault-adapter";

describe("isFolderAlreadyExistsError", () => {
  test("matches Obsidian createFolder race message", () => {
    expect(isFolderAlreadyExistsError(new Error("Folder already exists."))).toBe(true);
    expect(isFolderAlreadyExistsError(new Error("something else"))).toBe(false);
  });
});

describe("VaultAdapter write / ensureParentDir", () => {
  test("writes config paths via DataAdapter not createBinary", async () => {
    const onDiskFolders = new Set<string>([".obsidian", ".obsidian/plugins"]);
    const files = new Map<string, ArrayBuffer>();
    let createBinaryCalls = 0;

    const vault = {
      getFiles: () => [],
      readBinary: async () => new ArrayBuffer(0),
      getAbstractFileByPath: () => null,
      createFolder: async () => {
        throw new Error("should use adapter.mkdir for config paths");
      },
      createBinary: async () => {
        createBinaryCalls++;
      },
      modifyBinary: async () => {},
      adapter: {
        exists: async (path: string) => onDiskFolders.has(path) || files.has(path),
        mkdir: async (path: string) => {
          if (onDiskFolders.has(path)) {
            throw new Error("Folder already exists.");
          }
          onDiskFolders.add(path);
        },
        writeBinary: async (path: string, data: ArrayBuffer) => {
          files.set(path, data);
        },
        readBinary: async () => new ArrayBuffer(0),
        remove: async () => {},
        rename: async () => {},
        stat: async () => ({ mtime: 0, size: 0 }),
      },
    };

    const adapter = new VaultAdapter(vault as never, [], {} as never);
    const path = ".obsidian/plugins/obsidian-icon-folder/icons/tabler-icons/CarouselHorizontal.svg";
    const data = new TextEncoder().encode("<svg/>");

    await expect(adapter.write(path, data)).resolves.toBeUndefined();
    expect(createBinaryCalls).toBe(0);
    expect(onDiskFolders.has(".obsidian/plugins/obsidian-icon-folder")).toBe(true);
    expect(onDiskFolders.has(".obsidian/plugins/obsidian-icon-folder/icons")).toBe(true);
    expect(onDiskFolders.has(".obsidian/plugins/obsidian-icon-folder/icons/tabler-icons")).toBe(true);
    expect(files.has(path)).toBe(true);
  });

  test("parallel writes to the same new parent folder both succeed via adapter", async () => {
    const onDiskFolders = new Set<string>([".obsidian", ".obsidian/plugins"]);
    const files = new Map<string, ArrayBuffer>();
    let mkdirCalls = 0;

    const vault = {
      getFiles: () => [],
      readBinary: async () => new ArrayBuffer(0),
      getAbstractFileByPath: () => null,
      createFolder: async () => {
        throw new Error("should use adapter.mkdir");
      },
      createBinary: async () => {
        throw new Error("should use adapter.writeBinary");
      },
      modifyBinary: async () => {},
      adapter: {
        exists: async (path: string) => onDiskFolders.has(path) || files.has(path),
        mkdir: async (path: string) => {
          mkdirCalls++;
          if (onDiskFolders.has(path)) {
            throw new Error("Folder already exists.");
          }
          onDiskFolders.add(path);
        },
        writeBinary: async (path: string, data: ArrayBuffer) => {
          files.set(path, data);
        },
        readBinary: async () => new ArrayBuffer(0),
        remove: async () => {},
        rename: async () => {},
        stat: async () => ({ mtime: 0, size: 0 }),
      },
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
    expect(mkdirCalls).toBeGreaterThan(1);
  });

  test("writes indexed note paths via createBinary", async () => {
    const files = new Map<string, ArrayBuffer>();
    const folders = new Set<string>();
    let writeBinaryCalls = 0;

    const vault = {
      getFiles: () => [],
      readBinary: async () => new ArrayBuffer(0),
      getAbstractFileByPath: (path: string) => {
        if (files.has(path)) return { stat: { mtime: 0, size: 0 }, extension: "md" };
        if (folders.has(path)) return { children: {} };
        return null;
      },
      createFolder: async (path: string) => {
        folders.add(path);
      },
      createBinary: async (path: string, data: ArrayBuffer) => {
        files.set(path, data);
      },
      modifyBinary: async () => {},
      adapter: {
        exists: async () => false,
        mkdir: async () => {},
        writeBinary: async () => {
          writeBinaryCalls++;
        },
        readBinary: async () => new ArrayBuffer(0),
        remove: async () => {},
        rename: async () => {},
        stat: async () => ({ mtime: 0, size: 0 }),
      },
    };

    const adapter = new VaultAdapter(vault as never, [], {} as never);
    await adapter.write("Notes/hello.md", new TextEncoder().encode("hi"));
    expect(files.has("Notes/hello.md")).toBe(true);
    expect(writeBinaryCalls).toBe(0);
  });
});
