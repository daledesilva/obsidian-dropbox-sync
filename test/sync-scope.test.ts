import { describe, test, expect } from "bun:test";
import {
  assessRemoteFiles,
  classifyVaultPath,
  countEntry,
  countForScope,
  emptyScopeCounts,
  isPathInScope,
  isPathInSections,
  isSyncExcluded,
  resolveSyncScope,
  vaultEventShouldTriggerSync,
  vaultRenameShouldTriggerSync,
} from "@/sync/sync-scope";
import { getBuiltInExcludePatterns } from "@/settings";
import { MemoryRemoteStorage } from "@/adapters/memory";

const CONFIG = ".obsidian";
const BUILT_IN = getBuiltInExcludePatterns(CONFIG);

describe("classifyVaultPath", () => {
  test("notes at vault root", () => {
    expect(classifyVaultPath("Keep Imports/foo.md", CONFIG)).toBe("notes");
  });

  test("plugins under .obsidian", () => {
    expect(classifyVaultPath(".obsidian/plugins/foo/main.js", CONFIG)).toBe("plugins");
  });

  test("workspace files", () => {
    expect(classifyVaultPath(".obsidian/workspace.json", CONFIG)).toBe("workspaces");
    expect(classifyVaultPath(".obsidian/workspaces/foo.json", CONFIG)).toBe("workspaces");
  });

  test("other obsidian config is settings", () => {
    expect(classifyVaultPath(".obsidian/app.json", CONFIG)).toBe("settings");
    expect(classifyVaultPath(".obsidian/plugins.json", CONFIG)).toBe("settings");
  });
});

describe("isSyncExcluded via built-in patterns", () => {
  test(".git excluded when pattern list includes .git/", () => {
    expect(isSyncExcluded(".git/objects/ab/cd", BUILT_IN)).toBe(true);
    expect(isSyncExcluded("_sync-log.md", BUILT_IN)).toBe(true);
    expect(isSyncExcluded("sync-logs/_sync-log_2025-01-01-120000.md", BUILT_IN)).toBe(true);
    expect(isSyncExcluded("_sync-log_2025-01-01-120000.md", BUILT_IN)).toBe(true);
    expect(isSyncExcluded("sync-debug-abc.log", BUILT_IN)).toBe(true);
  });

  test("normal note is not excluded", () => {
    expect(isSyncExcluded("notes/foo.md", BUILT_IN)).toBe(false);
  });
});

describe("vaultEventShouldTriggerSync", () => {
  test("excluded plugin paths do not trigger", () => {
    expect(vaultEventShouldTriggerSync("sync-debug-abc.log", BUILT_IN)).toBe(false);
    expect(vaultEventShouldTriggerSync("sync-logs/_sync-log_2025.md", BUILT_IN)).toBe(false);
    expect(vaultEventShouldTriggerSync(".sync-state/entries.json", BUILT_IN)).toBe(false);
  });

  test("normal notes trigger", () => {
    expect(vaultEventShouldTriggerSync("notes/foo.md", BUILT_IN)).toBe(true);
  });
});

describe("vaultRenameShouldTriggerSync", () => {
  test("rename involving excluded path does not trigger", () => {
    expect(
      vaultRenameShouldTriggerSync("notes/a.md", "sync-debug-x.log", BUILT_IN),
    ).toBe(false);
    expect(
      vaultRenameShouldTriggerSync("sync-debug-a.log", "sync-debug-b.log", BUILT_IN),
    ).toBe(false);
  });

  test("rename between syncable paths triggers", () => {
    expect(vaultRenameShouldTriggerSync("notes/a.md", "notes/b.md", BUILT_IN)).toBe(true);
  });
});

describe("isPathInScope", () => {
  test("everything excludes .git via patterns", () => {
    expect(isPathInScope("a.md", "everything", CONFIG, BUILT_IN)).toBe(true);
    expect(isPathInScope(".git/HEAD", "everything", CONFIG, BUILT_IN)).toBe(false);
  });

  test("notes scope", () => {
    expect(isPathInScope("a.md", "notes", CONFIG, BUILT_IN)).toBe(true);
    expect(isPathInScope(".obsidian/app.json", "notes", CONFIG, BUILT_IN)).toBe(false);
    expect(isPathInScope(".obsidian/plugins/x/main.js", "notes", CONFIG, BUILT_IN)).toBe(false);
  });

  test("plugins scope", () => {
    expect(isPathInScope(".obsidian/plugins/p/main.js", "plugins", CONFIG, BUILT_IN)).toBe(true);
    expect(isPathInScope(".obsidian/app.json", "plugins", CONFIG, BUILT_IN)).toBe(false);
  });

  test("settings excludes plugins and workspaces", () => {
    expect(isPathInScope(".obsidian/app.json", "settings", CONFIG, BUILT_IN)).toBe(true);
    expect(isPathInScope(".obsidian/plugins/p/x.js", "settings", CONFIG, BUILT_IN)).toBe(false);
    expect(isPathInScope(".obsidian/workspace.json", "settings", CONFIG, BUILT_IN)).toBe(false);
  });

  test("workspaces scope", () => {
    // workspace.json is in exclude list; workspaces/ folder is the syncable workspace scope
    expect(isPathInScope(".obsidian/workspaces/foo.json", "workspaces", CONFIG, BUILT_IN)).toBe(true);
    expect(isPathInScope(".obsidian/app.json", "workspaces", CONFIG, BUILT_IN)).toBe(false);
  });
});

describe("isPathInSections", () => {
  test("union of notes and plugins", () => {
    const sections = ["notes", "plugins"] as const;
    expect(isPathInSections("a.md", [...sections], CONFIG, BUILT_IN)).toBe(true);
    expect(isPathInSections(".obsidian/plugins/p/main.js", [...sections], CONFIG, BUILT_IN)).toBe(true);
    expect(isPathInSections(".obsidian/app.json", [...sections], CONFIG, BUILT_IN)).toBe(false);
  });

  test("excluded paths are out of scope", () => {
    expect(isPathInSections(".git/HEAD", ["notes"], CONFIG, BUILT_IN)).toBe(false);
  });

  test("empty sections returns false", () => {
    expect(isPathInSections("a.md", [], CONFIG, BUILT_IN)).toBe(false);
  });
});

describe("countEntry and assessRemoteFiles", () => {
  test("countEntry buckets paths with built-in excludes", () => {
    const counts = emptyScopeCounts();
    countEntry(counts, "note.md", CONFIG, BUILT_IN);
    countEntry(counts, ".obsidian/app.json", CONFIG, BUILT_IN);
    countEntry(counts, ".obsidian/plugins/p/main.js", CONFIG, BUILT_IN);
    countEntry(counts, ".git/objects/x", CONFIG, BUILT_IN);
    expect(counts.notes).toBe(1);
    expect(counts.settings).toBe(1);
    expect(counts.plugins).toBe(1);
    expect(counts.excluded).toBe(1);
    expect(countForScope(counts, "notes")).toBe(1);
    expect(countForScope(counts, "everything")).toBe(3);
  });

  test("assessRemoteFiles lists remote storage", async () => {
    const remote = new MemoryRemoteStorage();
    const data = new TextEncoder().encode("x");
    await remote.upload("note.md", data);
    await remote.upload(".obsidian/app.json", data);
    await remote.upload(".git/HEAD", data);

    const counts = await assessRemoteFiles(remote, CONFIG, BUILT_IN);
    expect(counts.notes).toBe(1);
    expect(counts.settings).toBe(1);
    expect(counts.excluded).toBe(1);
  });

  test("workspace pattern in exclude list reduces workspace counts", () => {
    const counts = emptyScopeCounts();
    countEntry(counts, ".obsidian/workspace.json", CONFIG, BUILT_IN);
    expect(counts.workspaces).toBe(0);
    expect(counts.excluded).toBe(1);
  });

  test("resolveSyncScope: explicit choice updates last used", () => {
    expect(resolveSyncScope("notes", "everything")).toEqual({
      scope: "notes",
      lastUsedScope: "notes",
    });
  });

  test("resolveSyncScope: manual sync without explicit scope reuses last choice", () => {
    expect(resolveSyncScope(undefined, "notes")).toEqual({
      scope: "notes",
      lastUsedScope: "notes",
    });
  });
});
