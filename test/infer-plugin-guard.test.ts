import { describe, expect, test } from "bun:test";
import { shouldSkipPluginInfer } from "../src/sync/sync-diagnostics";

describe("shouldSkipPluginInfer", () => {
  test("inactive when plugins section not in scope", () => {
    expect(shouldSkipPluginInfer(false, 0, 5000)).toBe(false);
  });

  test("active when local plugins far below base", () => {
    expect(shouldSkipPluginInfer(true, 10, 5000)).toBe(true);
  });

  test("inactive when local plugins sufficient", () => {
    expect(shouldSkipPluginInfer(true, 3000, 5000)).toBe(false);
  });

  test("inactive when base small", () => {
    expect(shouldSkipPluginInfer(true, 0, 15)).toBe(false);
  });
});
