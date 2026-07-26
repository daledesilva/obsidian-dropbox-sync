import { describe, test, expect } from "bun:test";
import {
  getBuiltInExcludePatterns,
  getDefaultExcludePatterns,
  isObsoleteWorkspaceExcludePattern,
  mergeBuiltInExcludePatterns,
  migrateSettings,
} from "@/settings";
import { isExcluded } from "@/exclude";

describe("getBuiltInExcludePatterns", () => {
  test("includes .git, sync metadata, and device debug/report paths", () => {
    const patterns = getBuiltInExcludePatterns(".obsidian");
    expect(patterns).toContain(".git/");
    expect(patterns).toContain(".sync-state/");
    expect(patterns).toContain("sync-logs/");
    expect(patterns).toContain("sync-debug-*.log");
    // Workspaces are section-gated — not a built-in exclude.
    expect(patterns).not.toContain(".obsidian/workspace*");
    expect(patterns).toContain(".obsidian/plugins/dropbox-sync/data.json");
    expect(isExcluded("sync-debug-abcd.log", patterns)).toBe(true);
    expect(isExcluded("sync-logs/_sync-log_x.md", patterns)).toBe(true);
  });

  test("migrateSettings strips legacy workspace* excludes", () => {
    expect(isObsoleteWorkspaceExcludePattern(".obsidian/workspace*")).toBe(true);
    const migrated = migrateSettings({
      excludePatterns: [".obsidian/workspace*", "*.pdf", ".obsidian/plugins/dropbox-sync/data.json"],
    });
    expect(migrated.excludePatterns).toEqual([
      "*.pdf",
      ".obsidian/plugins/dropbox-sync/data.json",
    ]);
  });

  test("default equals built-in", () => {
    expect(getDefaultExcludePatterns(".obsidian")).toEqual(
      getBuiltInExcludePatterns(".obsidian"),
    );
  });

  test("merge adds missing built-in patterns", () => {
    const merged = mergeBuiltInExcludePatterns(["*.pdf"], ".obsidian");
    expect(merged).toContain("*.pdf");
    expect(merged).toContain(".git/");
  });

  test(".git paths match .git/ pattern", () => {
    const patterns = getBuiltInExcludePatterns(".obsidian");
    expect(isExcluded(".git/objects/ab", patterns)).toBe(true);
    expect(isExcluded("notes/x.md", patterns)).toBe(false);
  });
});
