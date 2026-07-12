import { describe, expect, test } from "bun:test";
import { listFilesRecursive } from "../src/adapters/vault-disk-list";

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

describe("listFilesRecursive", () => {
  test("lists nested files", async () => {
    const adapter = mockAdapter({
      "": { folders: [".obsidian"] },
      ".obsidian": { folders: ["plugins"] },
      ".obsidian/plugins": { folders: ["p1"] },
      ".obsidian/plugins/p1": { files: ["main.js", "manifest.json"] },
    });
    const files = await listFilesRecursive(adapter as never, "");
    expect(files.map((f) => f.path).sort()).toEqual([
      ".obsidian/plugins/p1/main.js",
      ".obsidian/plugins/p1/manifest.json",
    ]);
  });

  test("skips excluded directory prefixes", async () => {
    const adapter = mockAdapter({
      "": { folders: [".git", "notes"] },
      ".git": { files: ["config"] },
      notes: { files: ["a.md"] },
    });
    const files = await listFilesRecursive(adapter as never, "", {
      skipDirPrefixes: [".git"],
    });
    expect(files.map((f) => f.path)).toEqual(["notes/a.md"]);
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
