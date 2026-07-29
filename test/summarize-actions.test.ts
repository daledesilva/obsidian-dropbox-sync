import { describe, test, expect } from "bun:test";
import {
  actionSummaryModalTitle,
  isSameParentRename,
  summarizeActionParts,
  summarizeActions,
  toActionSummaryType,
} from "@/sync/sync-reporter";

const make = (type: string, fromPath?: string, toPath?: string) => ({
  action: fromPath && toPath
    ? { type, fromPath, toPath }
    : { type },
});

describe("summarizeActions", () => {
  test("빈 배열 → 'up to date'", () => {
    expect(summarizeActions([])).toBe("up to date");
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

  test("noop만 → 'up to date' (no transfer chips)", () => {
    expect(summarizeActions([make("noop"), make("noop")])).toBe("up to date");
  });
  test("recordBase만 → 'up to date'", () => {
    expect(summarizeActions([make("recordBase"), make("recordBase")])).toBe("up to date");
  });

  test("rename + move appear after download, before conflict", () => {
    const items = [
      make("conflict"),
      make("moveRemote", "a/x.md", "b/x.md"),
      make("moveRemote", "a/old.md", "a/new.md"),
      make("download"),
      make("upload"),
    ];
    expect(summarizeActions(items)).toBe(
      "\u21911 \u2022 \u21931 \u2022 Aa1 \u2022 \u21B31 \u2022 \u{1F6AB} 1 conflict",
    );
  });
});

describe("isSameParentRename / toActionSummaryType", () => {
  test("same parent basename change is a rename", () => {
    expect(isSameParentRename("a/x.md", "a/y.md")).toBe(true);
  });

  test("cross-directory path change is not a rename", () => {
    expect(isSameParentRename("a/x.md", "b/x.md")).toBe(false);
  });

  test("case-only same parent is a rename", () => {
    expect(isSameParentRename("notes/Bulk", "notes/bulk")).toBe(true);
  });

  test("identical path is not a rename", () => {
    expect(isSameParentRename("a/x.md", "a/x.md")).toBe(false);
  });

  test("moveRemote same parent → rename chip", () => {
    expect(toActionSummaryType({
      type: "moveRemote",
      fromPath: "notes/old.md",
      toPath: "notes/new.md",
    })).toBe("rename");
  });

  test("moveRemote cross directory → move chip", () => {
    expect(toActionSummaryType({
      type: "moveRemote",
      fromPath: "folders/nested/a.md",
      toPath: "folders/a.md",
    })).toBe("move");
  });

  test("moveRemoteFolder same parent → rename chip", () => {
    expect(toActionSummaryType({
      type: "moveRemoteFolder",
      fromPath: "seeds/notes",
      toPath: "seeds/notes-renamed",
    })).toBe("rename");
  });

  test("moveLocalFolder cross directory → move chip", () => {
    expect(toActionSummaryType({
      type: "moveLocalFolder",
      fromPath: "folders",
      toPath: "case/folders",
    })).toBe("move");
  });

  test("moveRemote without from/to defaults to move", () => {
    expect(toActionSummaryType("moveRemote")).toBe("move");
  });

  test("createRemoteFolder → upload chip", () => {
    expect(toActionSummaryType("createRemoteFolder")).toBe("upload");
  });

  test("createLocalFolder → download chip", () => {
    expect(toActionSummaryType("createLocalFolder")).toBe("download");
  });
});

describe("actionSummaryModalTitle", () => {
  test("titles are file/folder-agnostic (no trailing Files)", () => {
    expect(actionSummaryModalTitle("failed")).toBe("Failed");
    expect(actionSummaryModalTitle("upload")).toBe("Uploaded");
    expect(actionSummaryModalTitle("download")).toBe("Downloaded");
    expect(actionSummaryModalTitle("rename")).toBe("Renamed");
    expect(actionSummaryModalTitle("move")).toBe("Moved");
    expect(actionSummaryModalTitle("conflict")).toBe("Conflicted");
    expect(actionSummaryModalTitle("deleteLocal")).toBe("Local Deletions");
    expect(actionSummaryModalTitle("deleteRemote")).toBe("Cloud Deletions");
  });
});

describe("summarizeActionParts rename/move grouping", () => {
  test("groups moveRemote same-parent as rename and cross-dir as move", () => {
    const parts = summarizeActionParts([
      make("moveRemote", "a/old.md", "a/new.md"),
      make("moveRemoteFolder", "folders", "case/folders"),
      make("moveLocal", "x/y.md", "x/z.md"),
    ]);
    expect(parts).toEqual([
      { type: "rename", count: 2 },
      { type: "move", count: 1 },
    ]);
  });

  test("createRemoteFolder folds into upload chip beside deleteRemoteFolder", () => {
    const parts = summarizeActionParts([
      make("moveRemote", "a/old.md", "a/new.md"),
      make("createRemoteFolder"),
      make("createRemoteFolder"),
      make("createRemoteFolder"),
      make("deleteRemoteFolder"),
      make("deleteRemoteFolder"),
      make("deleteRemoteFolder"),
    ]);
    expect(parts).toEqual([
      { type: "upload", count: 3 },
      { type: "rename", count: 1 },
      { type: "deleteRemote", count: 3 },
    ]);
  });
});
