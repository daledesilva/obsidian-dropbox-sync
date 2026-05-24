import { describe, test, expect } from "bun:test";
import {
  getBuiltInExcludePatterns,
  getDefaultExcludePatterns,
  mergeBuiltInExcludePatterns,
} from "@/settings";
import { isExcluded } from "@/exclude";

describe("getBuiltInExcludePatterns", () => {
  test("includes .git and sync metadata paths", () => {
    const patterns = getBuiltInExcludePatterns(".obsidian");
    expect(patterns).toContain(".git/");
    expect(patterns).toContain(".sync-state/");
    expect(patterns).toContain("sync-logs/");
    expect(patterns).toContain("_sync-log.md");
    expect(patterns).toContain("_sync-log_*.md");
    expect(patterns).toContain(".obsidian/workspace*");
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
