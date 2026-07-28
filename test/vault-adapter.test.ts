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
        rename: async (from: string, to: string) => {
          const data = files.get(from);
          if (data) {
            files.delete(from);
            files.set(to, data);
          }
        },
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
        rename: async (from: string, to: string) => {
          const data = files.get(from);
          if (data) {
            files.delete(from);
            files.set(to, data);
          }
        },
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
    let modifyBinaryCalls = 0;

    const fileManager = {
      renameFile: async (file: { path: string }, to: string) => {
        if (files.has(to)) {
          throw new Error("Destination file already exists!");
        }
        const data = files.get(file.path);
        if (data) {
          files.delete(file.path);
          files.set(to, data);
        }
      },
      trashFile: async (file: { path: string }) => {
        files.delete(file.path);
      },
    };

    const vault = {
      getFiles: () => [],
      readBinary: async () => new ArrayBuffer(0),
      getAbstractFileByPath: (path: string) => {
        if (files.has(path)) return { path, stat: { mtime: 0, size: 0 }, extension: "md" };
        if (folders.has(path)) return { children: {} };
        return null;
      },
      createFolder: async (path: string) => {
        folders.add(path);
      },
      createBinary: async (path: string, data: ArrayBuffer) => {
        files.set(path, data);
      },
      modifyBinary: async (file: { path: string }, data: ArrayBuffer) => {
        modifyBinaryCalls++;
        files.set(file.path, data);
      },
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

    const adapter = new VaultAdapter(vault as never, [], fileManager as never);
    await adapter.write("Notes/hello.md", new TextEncoder().encode("hi"));
    expect(files.has("Notes/hello.md")).toBe(true);
    expect(writeBinaryCalls).toBe(0);

    // Overwrite must use modifyBinary — renameFile refuses an existing destination.
    await adapter.write("Notes/hello.md", new TextEncoder().encode("hi2"));
    expect(modifyBinaryCalls).toBe(1);
    expect(new TextDecoder().decode(new Uint8Array(files.get("Notes/hello.md")!))).toBe("hi2");
  });

  test("overwrite cleans leftover .tmp-dropbox-sync sibling via trash", async () => {
    const files = new Map<string, ArrayBuffer>();
    const folders = new Set<string>(["Notes"]);
    const trashed: string[] = [];
    let modifyBinaryCalls = 0;
    let renameCalls = 0;

    const fileManager = {
      renameFile: async (file: { path: string }, to: string) => {
        renameCalls++;
        if (files.has(to)) {
          throw new Error("Destination file already exists!");
        }
        const data = files.get(file.path);
        if (data) {
          files.delete(file.path);
          files.set(to, data);
        }
      },
      trashFile: async (file: { path: string }) => {
        trashed.push(file.path);
        files.delete(file.path);
      },
    };

    const vault = {
      getFiles: () => [],
      getAbstractFileByPath: (path: string) => {
        if (!files.has(path)) {
          if (folders.has(path)) return { children: {} };
          return null;
        }
        return { path, stat: { mtime: 0, size: 0 }, extension: "md" };
      },
      createFolder: async (path: string) => {
        folders.add(path);
      },
      createBinary: async (path: string, data: ArrayBuffer) => {
        files.set(path, data);
        return { path };
      },
      modifyBinary: async (file: { path: string }, data: ArrayBuffer) => {
        modifyBinaryCalls++;
        files.set(file.path, data);
      },
      readBinary: async () => new ArrayBuffer(0),
      adapter: {
        exists: async () => false,
        mkdir: async () => {},
        writeBinary: async () => {},
        readBinary: async () => new ArrayBuffer(0),
        remove: async () => {},
        rename: async () => {},
        stat: async () => ({ mtime: 0, size: 0 }),
      },
    };

    const adapter = new VaultAdapter(vault as never, [], fileManager as never);
    files.set("Notes/hello.md", new TextEncoder().encode("old").buffer);
    files.set(
      "Notes/hello.md.tmp-dropbox-sync",
      new TextEncoder().encode("stale temp").buffer,
    );

    await adapter.write("Notes/hello.md", new TextEncoder().encode("new"));
    expect(modifyBinaryCalls).toBe(1);
    expect(renameCalls).toBe(0);
    expect(trashed).toContain("Notes/hello.md.tmp-dropbox-sync");
    expect(files.has("Notes/hello.md.tmp-dropbox-sync")).toBe(false);
    expect(new TextDecoder().decode(new Uint8Array(files.get("Notes/hello.md")!))).toBe("new");
  });

  test("new indexed file still uses temp sibling then rename", async () => {
    const files = new Map<string, ArrayBuffer>();
    const folders = new Set<string>();
    let createBinaryCalls = 0;
    let renameCalls = 0;
    let modifyBinaryCalls = 0;

    const fileManager = {
      renameFile: async (file: { path: string }, to: string) => {
        renameCalls++;
        const data = files.get(file.path);
        if (data) {
          files.delete(file.path);
          files.set(to, data);
        }
      },
      trashFile: async (file: { path: string }) => {
        files.delete(file.path);
      },
    };

    const vault = {
      getFiles: () => [],
      getAbstractFileByPath: (path: string) => {
        if (files.has(path)) {
          return { path, stat: { mtime: 0, size: 0 }, extension: "md" };
        }
        if (folders.has(path)) return { children: {} };
        return null;
      },
      createFolder: async (path: string) => {
        folders.add(path);
      },
      createBinary: async (path: string, data: ArrayBuffer) => {
        createBinaryCalls++;
        files.set(path, data);
        return { path, stat: { mtime: 0, size: 0 }, extension: "md" };
      },
      modifyBinary: async (file: { path: string }, data: ArrayBuffer) => {
        modifyBinaryCalls++;
        files.set(file.path, data);
      },
      readBinary: async () => new ArrayBuffer(0),
      adapter: {
        exists: async () => false,
        mkdir: async () => {},
        writeBinary: async () => {},
        readBinary: async () => new ArrayBuffer(0),
        remove: async () => {},
        rename: async () => {},
        stat: async () => ({ mtime: 0, size: 0 }),
      },
    };

    const adapter = new VaultAdapter(vault as never, [], fileManager as never);
    await adapter.write("Notes/brand-new.md", new TextEncoder().encode("hi"));
    expect(createBinaryCalls).toBe(1);
    expect(renameCalls).toBe(1);
    expect(modifyBinaryCalls).toBe(0);
    expect(files.has("Notes/brand-new.md")).toBe(true);
    expect(files.has("Notes/brand-new.md.tmp-dropbox-sync")).toBe(false);
  });
});
