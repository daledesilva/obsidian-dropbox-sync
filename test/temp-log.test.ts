import { describe, expect, test } from "bun:test";
import { logTemp } from "@/debug/temp-log";
import type { CursorDebugLogMeta } from "@/debug/cursor-debug-ingest";

describe("logTemp", () => {
  test("prefixes TEMP and stamps meta.temp", () => {
    const seen: { message: string; meta?: CursorDebugLogMeta }[] = [];
    logTemp(
      (message, _data, meta) => {
        seen.push({ message, meta });
      },
      "P1",
      "overwrite mode avoided",
      { path: "note.md" },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.message).toBe("TEMP overwrite mode avoided");
    expect(seen[0]!.meta?.temp).toBe("P1");
  });

  test("does not double-prefix TEMP", () => {
    const seen: string[] = [];
    logTemp((message) => {
      seen.push(message);
    }, "P2", "TEMP already prefixed");
    expect(seen[0]).toBe("TEMP already prefixed");
  });
});
