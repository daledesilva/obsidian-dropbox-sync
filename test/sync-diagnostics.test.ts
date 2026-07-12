import { describe, expect, test } from "bun:test";
import {
  countDeleteIntentSources,
  summarizeDeletePlan,
} from "../src/sync/sync-diagnostics";
import type { SyncPlanItem } from "../src/types";

describe("sync-diagnostics", () => {
  test("countDeleteIntentSources", () => {
    const sources = new Map<string, "event" | "inferred" | "persisted">([
      ["a.md", "event"],
      ["b.md", "inferred"],
      ["c.md", "persisted"],
      ["d.md", "inferred"],
    ]);
    expect(countDeleteIntentSources(["a.md", "b.md", "c.md", "d.md", "e.md"], sources)).toEqual({
      event: 1,
      inferred: 2,
      persisted: 1,
    });
  });

  test("summarizeDeletePlan groups deleteRemote by intent source", () => {
    const sources = new Map<string, "event" | "inferred" | "persisted">([
      [".obsidian/plugins/p1/main.js", "inferred"],
      [".obsidian/plugins/p2/main.js", "inferred"],
      ["notes/x.md", "event"],
    ]);
    const items: SyncPlanItem[] = [
      {
        pathLower: ".obsidian/plugins/p1/main.js",
        localPath: ".obsidian/plugins/p1/main.js",
        action: { type: "deleteRemote", reason: "deleted_on_local" },
      },
      {
        pathLower: ".obsidian/plugins/p2/main.js",
        localPath: ".obsidian/plugins/p2/main.js",
        action: { type: "deleteRemote", reason: "deleted_on_local" },
      },
      {
        pathLower: "notes/x.md",
        localPath: "notes/x.md",
        action: { type: "deleteRemote", reason: "deleted_on_local" },
      },
      {
        pathLower: "notes/y.md",
        localPath: "notes/y.md",
        action: { type: "deleteLocal", reason: "deleted_on_remote" },
      },
    ];
    const summary = summarizeDeletePlan({ items, stats: {} as never }, sources);
    expect(summary.deleteRemote).toBe(3);
    expect(summary.deleteLocal).toBe(1);
    expect(summary.deleteRemoteBySource).toEqual({ inferred: 2, event: 1 });
    expect(summary.deleteRemoteSample).toHaveLength(3);
  });
});
