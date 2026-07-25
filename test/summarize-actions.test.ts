import { describe, test, expect } from "bun:test";
import { summarizeActions } from "@/sync/sync-reporter";

const make = (type: string) => ({ action: { type } });

describe("summarizeActions", () => {
  test("빈 배열 → '0 synced'", () => {
    expect(summarizeActions([])).toBe("0 synced");
  });

  test("upload만 → ↑N", () => {
    expect(summarizeActions([make("upload"), make("upload")])).toBe("↑2");
  });

  test("download만 → ↓N", () => {
    expect(summarizeActions([make("download")])).toBe("↓1");
  });

  test("혼합 → 순서: upload download conflict deleteLocal deleteRemote", () => {
    const items = [
      make("deleteRemote"),
      make("upload"),
      make("download"),
      make("conflict"),
      make("deleteLocal"),
    ];
    expect(summarizeActions(items)).toBe(
      "\u21911 \u2022 \u21931 \u2022 \u{1F6AB} 1 conflict \u2022 \u2193\u{1F5D1}1 \u2022 \u2191\u{1F5D1}1",
    );
  });

  test("conflicts → plural wording", () => {
    expect(summarizeActions([make("conflict"), make("conflict")])).toBe(
      "\u{1F6AB} 2 conflicts",
    );
  });

  test("noop만 → 'N synced'", () => {
    expect(summarizeActions([make("noop"), make("noop")])).toBe("2 synced");
  });
});
