import { describe, expect, test } from "bun:test";
import {
  listFilesRecursive,
  resolveListedChildPath,
} from "../src/adapters/vault-disk-list";

function mockAdapter(tree: Record<string, { files?: string[]; folders?: string[] }>) {
  return {
    exists: async (path: string) => path in tree || path === "",
    list: async (path: string) => ({
      files: tree[path]?.files ?? [],
      folders: tree[path]?.folders ?? [],
    }),
    stat: async (path: string) => ({ mtime: 1000, size: 10, type: "file" as const }),
  };
}

describe("resolveListedChildPath", () => {
  test("joins basename entries under dir", () => {
    expect(resolveListedChildPath(".obsidian", "plugins")).toBe(".obsidian/plugins");
  });

  test("does not double-prefix vault-relative entries from Obsidian adapter.list", () => {
    // Desktop FileSystemAdapter returns full vault-relative paths in list().
    expect(resolveListedChildPath(".obsidian", ".obsidian/plugins")).toBe(
      ".obsidian/plugins",
    );
    expect(resolveListedChildPath(".obsidian", ".obsidian/app.json")).toBe(
      ".obsidian/app.json",
    );
  });
});

describe("listFilesRecursive", () => {
  test("lists nested files (basename list entries)", async () => {
    const adapter = mockAdapter({
      "": { folders: [".obsidian"] },
      ".obsidian": { folders: ["plugins"] },
      ".obsidian/plugins": { folders: ["p1"] },
      ".obsidian/plugins/p1": { files: ["main.js", "manifest.json"] },
    });
    const listed = await listFilesRecursive(adapter as never, "");
    expect(listed.files.map((f) => f.path).sort()).toEqual([
      ".obsidian/plugins/p1/main.js",
      ".obsidian/plugins/p1/manifest.json",
    ]);
  });

  test("lists nested files when adapter.list returns vault-relative paths", async () => {
    // Matches Obsidian desktop adapter.list behavior — without resolveListedChildPath
    // this produced ".obsidian/.obsidian/plugins" and configDiskAdded: 0.
    const adapter = mockAdapter({
      ".obsidian": {
        files: [".obsidian/app.json", ".obsidian/community-plugins.json"],
        folders: [".obsidian/plugins"],
      },
      ".obsidian/plugins": {
        folders: [".obsidian/plugins/dropbox-sync"],
      },
      ".obsidian/plugins/dropbox-sync": {
        files: [
          ".obsidian/plugins/dropbox-sync/main.js",
          ".obsidian/plugins/dropbox-sync/manifest.json",
        ],
      },
    });
    const listed = await listFilesRecursive(adapter as never, ".obsidian");
    expect(listed.listErrors).toEqual([]);
    expect(listed.files.map((f) => f.path).sort()).toEqual([
      ".obsidian/app.json",
      ".obsidian/community-plugins.json",
      ".obsidian/plugins/dropbox-sync/main.js",
      ".obsidian/plugins/dropbox-sync/manifest.json",
    ]);
  });

  test("skips excluded directory prefixes", async () => {
    const adapter = mockAdapter({
      "": { folders: [".git", "notes"] },
      ".git": { files: ["config"] },
      notes: { files: ["a.md"] },
    });
    const listed = await listFilesRecursive(adapter as never, "", {
      skipDirPrefixes: [".git"],
    });
    expect(listed.files.map((f) => f.path)).toEqual(["notes/a.md"]);
  });

  test("respects abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = mockAdapter({
      "": { folders: ["a"] },
      a: { files: ["x.txt"] },
    });
    await expect(
      listFilesRecursive(adapter as never, "", { signal: controller.signal }),
    ).rejects.toThrow();
  });
});
