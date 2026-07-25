import { describe, expect, test } from "bun:test";
import {
  shouldSkipInferForIncompleteLocal,
  shouldSkipNotesInfer,
  shouldSkipPluginInfer,
} from "../src/sync/sync-diagnostics";

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

describe("shouldSkipNotesInfer", () => {
  test("active when local notes far below base (mass false delete)", () => {
    expect(shouldSkipNotesInfer(true, 1, 576)).toBe(true);
  });

  test("inactive when local notes sufficient", () => {
    expect(shouldSkipNotesInfer(true, 400, 576)).toBe(false);
  });
});

describe("shouldSkipInferForIncompleteLocal", () => {
  test("shared threshold matches section helpers", () => {
    expect(shouldSkipInferForIncompleteLocal(true, 1, 576)).toBe(true);
    expect(shouldSkipInferForIncompleteLocal(false, 1, 576)).toBe(false);
  });
});
