import { describe, test, expect } from "bun:test";
import {
  conflictPathToCanonicalPath,
  isConflictFile,
  isDropboxConflictFile,
  isLegacyConflictFile,
  isConflictSiblingOf,
  makeConflictPath,
} from "@/sync/conflict-handlers";
import { isConflictFile as isConflictFileFromEngine } from "@/sync/engine";
import { SyncSimulator } from "./support/sync-simulator";

describe("isConflictFile", () => {
  test("legacy .conflict-* pattern", () => {
    expect(isLegacyConflictFile("note.conflict-2026-03-06T1432.md")).toBe(true);
    expect(isLegacyConflictFile("folder/deep/note.conflict-2026-01-01T0000.md")).toBe(true);
    expect(isConflictFile("note.conflict-2026-03-06T1432.md")).toBe(true);
  });

  test("Dropbox conflicted copy pattern", () => {
    expect(isDropboxConflictFile("note (Device abcd's conflicted copy 2026-07-26).md")).toBe(true);
    expect(isDropboxConflictFile("note (Device abcd's conflicted copy 2026-07-26 2).md")).toBe(true);
    expect(isConflictFile("note (Device abcd's conflicted copy 2026-07-26).md")).toBe(true);
  });

  test("ordinary files are not conflict copies", () => {
    expect(isConflictFile("note.md")).toBe(false);
    expect(isConflictFile("conflict-notes.md")).toBe(false);
    expect(isConflictFile("my.conflict.md")).toBe(false);
    expect(isConflictFile("note.conflict-invalid.md")).toBe(false);
  });

  test("engine re-exports detection helper", () => {
    expect(isConflictFileFromEngine("note (Device x's conflicted copy 2026-07-26).md")).toBe(true);
  });
});

describe("conflict path association", () => {
  test("maps legacy and Dropbox copies to canonical path", () => {
    expect(conflictPathToCanonicalPath("note.conflict-2026-03-06T1432.md")).toBe("note.md");
    expect(conflictPathToCanonicalPath("note (Device abcd's conflicted copy 2026-07-26).md")).toBe("note.md");
    expect(conflictPathToCanonicalPath("notes/doc (Device abcd's conflicted copy 2026-07-26 2).md")).toBe("notes/doc.md");
  });

  test("isConflictSiblingOf accepts both formats", () => {
    expect(isConflictSiblingOf("note.conflict-2026-03-06T1432.md", "note.md")).toBe(true);
    expect(isConflictSiblingOf("note (Device abcd's conflicted copy 2026-07-26).md", "note.md")).toBe(true);
    expect(isConflictSiblingOf("other.md", "note.md")).toBe(false);
  });
});

describe("makeConflictPath", () => {
  test("Dropbox format with device label and date", () => {
    const path = makeConflictPath("test.md", [], {
      deviceLabel: "Device test",
      now: new Date("2026-07-26T12:00:00Z"),
    });
    expect(path).toBe("test (Device test's conflicted copy 2026-07-26).md");
  });

  test("same-day counter when copy already exists", () => {
    const existing = ["test (Device test's conflicted copy 2026-07-26).md"];
    const path = makeConflictPath("test.md", existing, {
      deviceLabel: "Device test",
      now: new Date("2026-07-26T15:00:00Z"),
    });
    expect(path).toBe("test (Device test's conflicted copy 2026-07-26 2).md");
  });
});

describe("conflict copies sync as ordinary files (G1)", () => {
  test("local conflict copy uploads to Dropbox", async () => {
    const sim = new SyncSimulator();
    const a = sim.addDevice("A");

    await a.editFile("note.md", "content");
    await a.editFile("note (Device abcd's conflicted copy 2026-07-26).md", "remote version");
    await a.sync();

    expect(sim.remote.has("note.md")).toBe(true);
    expect(sim.remote.has("note (Device abcd's conflicted copy 2026-07-26).md")).toBe(true);
  });

  test("remote conflict copy downloads to other devices", async () => {
    const sim = new SyncSimulator();
    const a = sim.addDevice("A");
    const b = sim.addDevice("B");

    await a.editFile("note.md", "content");
    await a.sync();

    await sim.remote.upload(
      "note (Device abcd's conflicted copy 2026-07-26).md",
      new TextEncoder().encode("old conflict"),
    );

    await b.sync();
    expect(b.hasFile("note.md")).toBe(true);
    expect(b.hasFile("note (Device abcd's conflicted copy 2026-07-26).md")).toBe(true);
  });

  test("deleting a conflict copy produces deleteRemote", async () => {
    const sim = new SyncSimulator();
    const a = sim.addDevice("A");

    await a.editFile("note.md", "content");
    await a.sync();

    const conflictPath = "note (Device abcd's conflicted copy 2026-07-26).md";
    await a.editFile(conflictPath, "conflict data");
    await a.sync();
    expect(sim.remote.has(conflictPath)).toBe(true);

    await a.deleteFile(conflictPath);
    const { plan } = await a.sync();
    const deleteActions = plan.items.filter(
      (i) => i.action.type === "deleteRemote" && i.localPath === conflictPath,
    );
    expect(deleteActions.length).toBeGreaterThan(0);
  });
});
