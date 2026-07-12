import { describe, expect, test } from "bun:test";
import { VaultAdapter } from "@/adapters/vault-adapter";

interface MockFile {
  path: string;
  stat: { mtime: number; size: number };
  extension: string;
  data: ArrayBuffer;
}

function createMockVault(files: MockFile[], adapterTree: Record<string, { files?: string[]; folders?: string[] }>) {
  const fileMap = new Map<string, MockFile>();
  for (const f of files) fileMap.set(f.path, f);

  const adapter = {
    exists: async (path: string) => path in adapterTree || path === "",
    list: async (path: string) => ({
      files: adapterTree[path]?.files ?? [],
      folders: adapterTree[path]?.folders ?? [],
    }),
    readBinary: async (path: string) => {
      const norm = path.replace(/^\//, "");
      const f = fileMap.get(norm);
      if (f) return f.data;
      const disk = findDiskFile(adapterTree, norm);
      if (disk) return disk.data;
      throw new Error(`not found: ${path}`);
    },
    stat: async (path: string) => {
      const norm = path.replace(/^\//, "");
      const f = fileMap.get(norm);
      if (f) return { mtime: f.stat.mtime, size: f.stat.size, type: "file" as const };
      const disk = findDiskFile(adapterTree, norm);
      if (disk) return { mtime: disk.stat.mtime, size: disk.stat.size, type: "file" as const };
      throw new Error(`not found: ${path}`);
    },
  };

  const vault = {
    getFiles: () => [...fileMap.values()],
    getAbstractFileByPath: (path: string) => fileMap.get(path) ?? null,
    readBinary: async (file: MockFile) => file.data,
    adapter,
    trash: async () => {},
    modifyBinary: async () => {},
    createBinary: async () => {},
    createFolder: async () => {},
  };

  return vault;
}

function findDiskFile(
  tree: Record<string, { files?: string[]; folders?: string[] }>,
  path: string,
): MockFile | null {
  for (const [dir, entry] of Object.entries(tree)) {
    for (const name of entry.files ?? []) {
      const full = dir ? `${dir}/${name}` : name;
      if (full === path) {
        return {
          path: full,
          stat: { mtime: 2000, size: 5 },
          extension: "js",
          data: new TextEncoder().encode("disk").buffer,
        };
      }
    }
  }
  return null;
}

describe("VaultAdapter disk scan", () => {
  test("merges config disk files not in getFiles", async () => {
    const vault = createMockVault(
      [{ path: "note.md", stat: { mtime: 1, size: 4 }, extension: "md", data: new TextEncoder().encode("note").buffer }],
      {
        "": { folders: [".obsidian"] },
        ".obsidian": { folders: ["plugins"] },
        ".obsidian/plugins": { folders: ["p1"] },
        ".obsidian/plugins/p1": { files: ["main.js"] },
      },
    );
    const va = new VaultAdapter(vault as never, [".git/"], {} as never);
    const listed = await va.list({
      configDir: ".obsidian",
      configDiskScan: true,
      includeHiddenFilesAndFolders: false,
    });
    expect(listed.map((f) => f.path).sort()).toEqual([".obsidian/plugins/p1/main.js", "note.md"]);
    expect(va.lastListStats.vaultIndexed).toBe(1);
    expect(va.lastListStats.configDiskAdded).toBe(1);
    expect(va.lastListStats.mergedAfterExclude).toBe(2);
  });

  test("read uses adapter for disk-only path", async () => {
    const vault = createMockVault(
      [],
      {
        ".obsidian": { folders: ["plugins"] },
        ".obsidian/plugins": { folders: ["p1"] },
        ".obsidian/plugins/p1": { files: ["main.js"] },
      },
    );
    const va = new VaultAdapter(vault as never, [], {} as never);
    await va.list({ configDir: ".obsidian", configDiskScan: true });
    const data = await va.read(".obsidian/plugins/p1/main.js");
    expect(new TextDecoder().decode(data)).toBe("disk");
  });

  test("exclude-after-merge drops .git discovered on disk", async () => {
    const vault = createMockVault(
      [],
      {
        "": { folders: [".git", "notes"] },
        ".git": { files: ["HEAD"] },
        notes: { files: ["a.md"] },
      },
    );
    const va = new VaultAdapter(vault as never, [".git/"], {} as never);
    const listed = await va.list({
      configDir: ".obsidian",
      configDiskScan: false,
      includeHiddenFilesAndFolders: true,
    });
    expect(listed.some((f) => f.path.startsWith(".git/"))).toBe(false);
    expect(listed.some((f) => f.path === "notes/a.md")).toBe(true);
  });
});
