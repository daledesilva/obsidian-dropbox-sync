import { describe, test, expect, beforeEach } from "bun:test";
import { patchDeviceSettings } from "@/device-settings/device-settings";
import { SyncSimulator, isOfflineCycleResult } from "../support/sync-simulator";
import { RecordingLog } from "../support/recording-log";

type ScenarioRow = {
  row: number;
  title: string;
  /** Historical gap id — kept for coverage map; prefer `run` once automated. */
  gap?: string;
  run?: () => Promise<void>;
};

const SCENARIO_ROWS: ScenarioRow[] = [
  // §1 Creating a file
  {
    row: 1,
    title: "creates file, syncs",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("note.md", "hello");
      await A.sync();
      await B.sync();
      expect(B.hasFile("note.md")).toBe(true);
      expect(await B.readFile("note.md")).toBe("hello");
    },
  },
  {
    row: 2,
    title: "creates file, stays offline",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("note.md", "offline draft");
      A.goOffline();
      const offline = await A.trySync();
      expect(isOfflineCycleResult(offline)).toBe(true);
      expect(sim.remote.has("note.md")).toBe(false);
      await B.sync();
      expect(B.hasFile("note.md")).toBe(false);
      A.goOnline();
      await A.sync();
      await B.sync();
      expect(B.hasFile("note.md")).toBe(true);
    },
  },
  {
    row: 3,
    title: "same path, same content",
    gap: "G4",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("note.md", "identical");
      await B.editFile("note.md", "identical");
      await A.sync();
      await B.sync();
      expect(await B.readFile("note.md")).toBe("identical");
      expect(await B.findConflictSibling("note.md")).toBeUndefined();
      // G4: same_content must write base so the next cycle is not new_local.
      expect(await B.store.getEntry("note.md")).not.toBeNull();
      expect((await B.store.getEntry("note.md"))?.basePathDisplay).toBe("note.md");
    },
  },
  {
    row: 4,
    title: "same path, different content",
    gap: "G1, G2",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("note.md", "from A");
      await B.editFile("note.md", "from B");
      await A.sync();
      await B.sync();
      expect(await B.readFile("note.md")).toBe("from A");
      const conflictPath = await B.findConflictSibling("note.md");
      expect(conflictPath).toBeDefined();
      expect(conflictPath).toMatch(/conflicted copy \d{4}-\d{2}-\d{2}/);
      expect(await B.readFile(conflictPath!)).toBe("from B");
      expect(sim.remote.has(conflictPath!)).toBe(true);
      await A.sync();
      expect(A.hasFile(conflictPath!)).toBe(true);
    },
  },
  {
    row: 5,
    title: "three-way create conflict",
    gap: "G1, G2",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      const C = sim.addDevice("C");
      await A.editFile("note.md", "A");
      await B.editFile("note.md", "B");
      await C.editFile("note.md", "C");
      await A.sync();
      await B.sync();
      await C.sync();
      expect(await C.readFile("note.md")).toBe("A");
      expect(await C.findConflictSibling("note.md")).toBeDefined();
      await A.sync();
      await B.sync();
      await sim.assertConsistent("note.md");
    },
  },
  {
    row: 6,
    title: "three devices, identical content",
    gap: "G4",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      const C = sim.addDevice("C");
      await A.editFile("note.md", "same");
      await B.editFile("note.md", "same");
      await C.editFile("note.md", "same");
      await A.sync();
      await B.sync();
      await C.sync();
      await sim.assertAllConsistent();
      expect(await C.findConflictSibling("note.md")).toBeUndefined();
      expect(await C.store.getEntry("note.md")).not.toBeNull();
    },
  },
  {
    row: 7,
    title: "(Dropbox app) syncs",
    run: async () => {
      const sim = new SyncSimulator();
      const app = sim.addDropboxAppDevice("Dropbox");
      const A = sim.addDevice("A");
      await app.upload("note.md", "from finder");
      await A.sync();
      expect(await A.readFile("note.md")).toBe("from finder");
    },
  },

  // §2 Modifying a file
  {
    row: 8,
    title: "modifies file, syncs",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("note.md", "v1");
      await A.sync();
      await B.sync();
      await A.editFile("note.md", "v2");
      await A.sync();
      await B.sync();
      expect(await B.readFile("note.md")).toBe("v2");
    },
  },
  { row: 9, title: "modify while file open in editor", gap: "G10" },
  {
    row: 10,
    title: "simultaneous different modifications",
    gap: "G2",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("note.md", "original");
      await A.sync();
      await B.sync();
      await A.editFile("note.md", "version A");
      await B.editFile("note.md", "version B");
      await A.sync();
      await B.sync();
      expect(await B.readFile("note.md")).toBe("version A");
      const conflictPath = await B.findConflictSibling("note.md");
      expect(conflictPath).toBeDefined();
      expect(await B.readFile(conflictPath!)).toBe("version B");
      expect(sim.remote.has(conflictPath!)).toBe(true);
    },
  },
  {
    row: 11,
    title: "modify to identical content",
    gap: "G4",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("note.md", "v1");
      await A.sync();
      await B.sync();
      await A.editFile("note.md", "converged");
      await B.editFile("note.md", "converged");
      await A.sync();
      await B.sync();
      expect(await B.readFile("note.md")).toBe("converged");
      expect(await B.findConflictSibling("note.md")).toBeUndefined();
      expect(await B.store.getEntry("note.md")).not.toBeNull();
    },
  },
  {
    row: 12,
    title: "three-way modify conflict",
    gap: "G1, G2",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      const C = sim.addDevice("C");
      await A.editFile("note.md", "base");
      await A.sync();
      await B.sync();
      await C.sync();
      await A.editFile("note.md", "A");
      await B.editFile("note.md", "B");
      await C.editFile("note.md", "C");
      await A.sync();
      await B.sync();
      await C.sync();
      expect(await C.readFile("note.md")).toBe("A");
      expect(await C.findConflictSibling("note.md")).toBeDefined();
    },
  },
  {
    row: 13,
    title: "simultaneous upload rev rejection",
    gap: "G2",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("note.md", "base");
      await A.sync();
      await B.sync();
      await A.editFile("note.md", "A wins rev race");
      await B.editFile("note.md", "B loses rev");
      await A.sync();
      const cycle = await B.sync();
      expect(cycle.result.succeeded.some((i) => i.conflictSiblingPath)).toBe(true);
      expect(await B.readFile("note.md")).toBe("A wins rev race");
    },
  },
  {
    row: 14,
    title: "modify twice, sync after each",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("note.md", "v1");
      await A.sync();
      await B.sync();
      await A.editFile("note.md", "v2");
      await A.sync();
      await B.sync();
      await A.editFile("note.md", "v3");
      await A.sync();
      await B.sync();
      expect(await B.readFile("note.md")).toBe("v3");
    },
  },
  {
    row: 15,
    title: "modify then long offline return",
    gap: "G2",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("note.md", "shared");
      await A.sync();
      await B.sync();
      B.goOffline();
      await A.editFile("note.md", "A while B away");
      await A.sync();
      await B.editFile("note.md", "B offline edit");
      B.goOnline();
      await B.sync();
      expect(await B.readFile("note.md")).toBe("A while B away");
      expect(await B.findConflictSibling("note.md")).toBeDefined();
    },
  },
  {
    row: 16,
    title: "re-save with no content change",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("note.md", "same");
      await A.sync();
      await B.sync();
      const revBefore = sim.remote.getFile("note.md")?.rev;
      await A.editFile("note.md", "same", Date.now() + 60_000);
      await A.sync();
      await B.sync();
      expect(await B.readFile("note.md")).toBe("same");
      expect(sim.remote.getFile("note.md")?.rev).toBe(revBefore);
    },
  },
  {
    row: 17,
    title: "(Dropbox app) simultaneous modify",
    gap: "G23",
    run: async () => {
      const sim = new SyncSimulator();
      const app = sim.addDropboxAppDevice("Dropbox");
      const A = sim.addDevice("A");
      await A.editFile("note.md", "plugin");
      await A.sync();
      await app.upload("note.md", "finder edit");
      await A.editFile("note.md", "plugin again");
      await A.sync();
      expect(await A.readFile("note.md")).toBe("finder edit");
      expect(await A.findConflictSibling("note.md")).toBeDefined();
    },
  },

  // §3 Simultaneous editing
  { row: 18, title: "open editor, read-only on other device", gap: "G10" },
  {
    row: 19,
    title: "both typing, settled burst conflict",
    gap: "G18, G1, G2",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("note.md", "base");
      await A.sync();
      await B.sync();
      await A.editFile("note.md", "A1");
      await A.editFile("note.md", "A2");
      await B.editFile("note.md", "B1");
      await B.editFile("note.md", "B2");
      await A.sync();
      await B.sync();
      expect(await B.readFile("note.md")).toBe("A2");
      expect(await B.readFile((await B.findConflictSibling("note.md"))!)).toBe("B2");
    },
  },
  {
    row: 20,
    title: "three-way typing conflict",
    gap: "G1, G2",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      const C = sim.addDevice("C");
      await A.editFile("note.md", "base");
      await A.sync();
      await B.sync();
      await C.sync();
      await A.editFile("note.md", "Aa");
      await B.editFile("note.md", "Bb");
      await C.editFile("note.md", "Cc");
      await A.sync();
      await B.sync();
      await C.sync();
      expect(await C.findConflictSibling("note.md")).toBeDefined();
    },
  },
  { row: 21, title: "unsaved buffer on incoming change", gap: "G10, G27" },
  { row: 22, title: "continuous typing debounced" },
  { row: 23, title: "unsaved buffer after device sleep", gap: "G10, G27" },
  {
    row: 24,
    title: "unresolved conflict copy does not block note",
    gap: "G1",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("note.md", "base");
      await A.sync();
      await B.sync();
      await A.editFile("note.md", "A");
      await B.editFile("note.md", "B");
      await A.sync();
      await B.sync();
      const conflictPath = await B.findConflictSibling("note.md");
      expect(conflictPath).toBeDefined();
      await B.editFile("note.md", "A then more");
      await B.sync();
      expect(await B.readFile("note.md")).toBe("A then more");
      expect(B.hasFile(conflictPath!)).toBe(true);
    },
  },
  { row: 25, title: "(Dropbox app) simultaneous typing", gap: "G23" },

  // §4 Deleting a file
  {
    row: 26,
    title: "deletes file, syncs",
    gap: "G3",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("note.md", "bye");
      await A.sync();
      await B.sync();
      await A.deleteFile("note.md");
      await A.sync();
      await B.sync();
      expect(sim.remote.has("note.md")).toBe(false);
      expect(B.hasFile("note.md")).toBe(false);
    },
  },
  {
    row: 27,
    title: "both delete same file",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("note.md", "bye");
      await A.sync();
      await B.sync();
      await A.deleteFile("note.md");
      await B.deleteFile("note.md");
      await A.sync();
      await B.sync();
      expect(sim.remote.has("note.md")).toBe(false);
      expect(A.hasFile("note.md")).toBe(false);
      expect(B.hasFile("note.md")).toBe(false);
    },
  },
  {
    row: 28,
    title: "delete while device offline for months",
    gap: "G28",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("note.md", "old");
      await A.sync();
      await B.sync();
      B.goOffline();
      await A.deleteFile("note.md");
      await A.sync();
      B.goOnline();
      await B.sync();
      expect(B.hasFile("note.md")).toBe(false);
      expect(sim.remote.has("note.md")).toBe(false);
    },
  },
  { row: 29, title: "delete while file open in editor", gap: "G10, G27" },
  {
    row: 30,
    title: "create then delete before ever syncing",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("note.md", "ephemeral");
      await A.deleteFile("note.md");
      await A.sync();
      await B.sync();
      expect(sim.remote.has("note.md")).toBe(false);
      expect(B.hasFile("note.md")).toBe(false);
    },
  },
  { row: 31, title: "file missing without real delete", gap: "G22" },
  {
    row: 32,
    title: "delete then re-create same path",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("note.md", "v1");
      await A.sync();
      await B.sync();
      await A.deleteFile("note.md");
      await A.sync();
      await A.editFile("note.md", "v2");
      await A.sync();
      await B.sync();
      expect(await B.readFile("note.md")).toBe("v2");
    },
  },
  {
    row: 33,
    title: "delete propagates to offline rejoin",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("note.md", "x");
      await A.sync();
      await B.sync();
      B.goOffline();
      await A.deleteFile("note.md");
      await A.sync();
      B.goOnline();
      await B.sync();
      expect(B.hasFile("note.md")).toBe(false);
    },
  },
  {
    row: 34,
    title: "(Dropbox app) deletes in Finder",
    run: async () => {
      const sim = new SyncSimulator();
      const app = sim.addDropboxAppDevice("Dropbox");
      const A = sim.addDevice("A");
      await A.editFile("note.md", "x");
      await A.sync();
      await app.delete("note.md");
      await A.sync();
      expect(A.hasFile("note.md")).toBe(false);
    },
  },

  // §5 Delete crossed with edit
  {
    row: 35,
    title: "delete vs prior edit",
    gap: "notice",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("note.md", "original");
      await A.sync();
      await B.sync();
      await B.editFile("note.md", "B edited first");
      await A.deleteFile("note.md");
      await A.sync();
      await B.sync();
      expect(B.hasFile("note.md")).toBe(true);
      expect(await B.readFile("note.md")).toBe("B edited first");
    },
  },
  {
    row: 36,
    title: "edit vs prior delete",
    gap: "notice",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("note.md", "original");
      await A.sync();
      await B.sync();
      await A.deleteFile("note.md");
      await B.editFile("note.md", "B edited");
      await A.sync();
      await B.sync();
      expect(await B.readFile("note.md")).toBe("B edited");
      await A.sync();
      expect(await A.readFile("note.md")).toBe("B edited");
    },
  },
  {
    row: 37,
    title: "delete then edit restores file",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("note.md", "v1");
      await A.sync();
      await B.sync();
      await A.deleteFile("note.md");
      await A.sync();
      await A.editFile("note.md", "restored");
      await A.sync();
      await B.sync();
      expect(await B.readFile("note.md")).toBe("restored");
    },
  },
  { row: 38, title: "double delete vs edit" },
  {
    row: 39,
    title: "delete vs two edits",
    gap: "G2",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      const C = sim.addDevice("C");
      await A.editFile("note.md", "base");
      await A.sync();
      await B.sync();
      await C.sync();
      await A.deleteFile("note.md");
      await B.editFile("note.md", "B");
      await C.editFile("note.md", "C");
      await A.sync();
      await B.sync();
      await C.sync();
      expect(sim.remote.has("note.md")).toBe(true);
      expect(await B.readFile("note.md")).toMatch(/B|C/);
    },
  },
  {
    row: 40,
    title: "(Dropbox app) delete vs edit",
    gap: "notice",
    run: async () => {
      const sim = new SyncSimulator();
      const app = sim.addDropboxAppDevice("Dropbox");
      const A = sim.addDevice("A");
      await A.editFile("note.md", "base");
      await A.sync();
      await app.delete("note.md");
      await A.editFile("note.md", "edited after remote delete");
      await A.sync();
      expect(await A.readFile("note.md")).toBe("edited after remote delete");
      expect(sim.remote.has("note.md")).toBe(true);
    },
  },

  // §6 Renaming and moving
  {
    row: 41,
    title: "rename old.md to new.md",
    gap: "G7",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("old.md", "body");
      await A.sync();
      await B.sync();
      await A.rename("old.md", "new.md");
      await A.sync();
      await B.sync();
      expect(B.hasFile("new.md")).toBe(true);
      expect(B.hasFile("old.md")).toBe(false);
      expect(await B.readFile("new.md")).toBe("body");
      expect(sim.remote.has("new.md")).toBe(true);
      expect(sim.remote.has("old.md")).toBe(false);
    },
  },
  {
    row: 42,
    title: "move file to different folder",
    gap: "G7",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("note.md", "body");
      await A.sync();
      await B.sync();
      await A.rename("note.md", "docs/note.md");
      await A.sync();
      await B.sync();
      expect(B.hasFile("docs/note.md")).toBe(true);
      expect(B.hasFile("note.md")).toBe(false);
    },
  },
  { row: 43, title: "rename vs edit on old path", gap: "notice" },
  { row: 44, title: "conflicting renames", gap: "notice" },
  { row: 45, title: "platform-incompatible filename" },
  {
    row: 46,
    title: "(Dropbox app) renames in Finder",
    gap: "G7",
    run: async () => {
      const sim = new SyncSimulator();
      const app = sim.addDropboxAppDevice("Dropbox");
      const A = sim.addDevice("A");
      await A.editFile("old.md", "body");
      await A.sync();
      await app.move("old.md", "new.md");
      await A.sync();
      expect(A.hasFile("new.md")).toBe(true);
      expect(A.hasFile("old.md")).toBe(false);
    },
  },

  // §7 Capitalisation
  {
    row: 47,
    title: "rename note.md to Note.md",
    gap: "G6, C1",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("note.md", "body");
      await A.sync();
      await B.sync();
      await A.rename("note.md", "Note.md");
      const result = await A.sync();
      expect(result.cursorUpdated).toBe(true);
      expect(A.hasFile("Note.md")).toBe(true);
      expect(sim.remote.getFile("note.md")?.pathDisplay).toBe("Note.md");
      await B.sync();
      expect(B.hasFile("Note.md")).toBe(true);
    },
  },
  {
    row: 48,
    title: "rename back to note.md",
    gap: "G6, C1",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("note.md", "body");
      await A.sync();
      await B.sync();
      await A.rename("note.md", "Note.md");
      await A.sync();
      await B.sync();
      await A.rename("Note.md", "note.md");
      await A.sync();
      await B.sync();
      expect(B.hasFile("note.md")).toBe(true);
      expect(sim.remote.getFile("note.md")?.pathDisplay).toBe("note.md");
    },
  },
  { row: 49, title: "simultaneous case renames", gap: "G6" },
  {
    row: 50,
    title: "independent create, identical content, different case",
    gap: "G4, G6",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("note.md", "same");
      await B.editFile("Note.md", "same");
      await A.sync();
      await B.sync();
      expect(await B.findConflictSibling("note.md") ?? await B.findConflictSibling("Note.md")).toBeUndefined();
      expect(sim.remote.has("note.md")).toBe(true);
    },
  },
  {
    row: 51,
    title: "independent create, different content, different case",
    gap: "G2, G6",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("note.md", "from A");
      await B.editFile("Note.md", "from B");
      await A.sync();
      await B.sync();
      const sibling =
        (await B.findConflictSibling("note.md"))
        ?? (await B.findConflictSibling("Note.md"));
      expect(sibling).toBeDefined();
    },
  },
  { row: 52, title: "case rename vs edit on old casing", gap: "G6" },
  {
    row: 53,
    title: "(Dropbox app) case rename in Finder",
    gap: "G6",
    run: async () => {
      const sim = new SyncSimulator();
      const app = sim.addDropboxAppDevice("Dropbox");
      const A = sim.addDevice("A");
      await A.editFile("note.md", "body");
      await A.sync();
      await app.move("note.md", "Note.md");
      await A.sync();
      expect(A.hasFile("Note.md") || A.hasFile("note.md")).toBe(true);
    },
  },

  // §8 Folders and empty folders
  {
    row: 54,
    title: "creates empty Projects/ folder",
    gap: "G8",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.createFolder("Projects");
      await A.sync();
      await B.sync();
      expect(sim.remote.hasFolder("Projects")).toBe(true);
      const folders = await B.fs.listFolders();
      expect(folders.some((f) => f.pathLower === "projects")).toBe(true);
    },
  },
  {
    row: 55,
    title: "creates nested empty folders",
    gap: "G8",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.createFolder("a");
      await A.createFolder("a/b");
      await A.sync();
      await B.sync();
      expect(sim.remote.hasFolder("a/b")).toBe(true);
    },
  },
  {
    row: 56,
    title: "deletes empty folder",
    gap: "G8",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.createFolder("Projects");
      await A.sync();
      await B.sync();
      await A.deleteFolder("Projects");
      await A.sync();
      await B.sync();
      expect(sim.remote.hasFolder("Projects")).toBe(false);
    },
  },
  { row: 57, title: "renames empty folder", gap: "G8" },
  { row: 58, title: "conflicting folder casing", gap: "G8, G6" },
  { row: 59, title: "file vs folder name clash Draft", gap: "G8" },
  { row: 60, title: "folder with only excluded files", gap: "G8" },
  {
    row: 61,
    title: "empty folder then file inside",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.createFolder("Projects");
      await A.sync();
      await B.sync();
      await A.editFile("Projects/readme.md", "hi");
      await A.sync();
      await B.sync();
      expect(await B.readFile("Projects/readme.md")).toBe("hi");
    },
  },
  {
    row: 62,
    title: "(Dropbox app) creates empty folder",
    gap: "G8",
    run: async () => {
      const sim = new SyncSimulator();
      const app = sim.addDropboxAppDevice("Dropbox");
      const A = sim.addDevice("A");
      await app.createFolder("FromFinder");
      await A.sync();
      const folders = await A.fs.listFolders();
      expect(folders.some((f) => f.pathLower === "fromfinder")).toBe(true);
    },
  },

  // §9 Folders containing files
  {
    row: 63,
    title: "folder with file syncs",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("docs/a.md", "x");
      await A.sync();
      await B.sync();
      expect(await B.readFile("docs/a.md")).toBe("x");
    },
  },
  { row: 64, title: "delete folder with 12 files (coalesce)" },
  { row: 65, title: "delete folder, B has extra local files" },
  { row: 66, title: "delete folder, extra remote file blocks coalesce" },
  { row: 67, title: "delete folder with excluded file inside" },
  { row: 68, title: "delete folder, partial copy on C" },
  { row: 69, title: "delete folder vs new file inside", gap: "G8" },
  { row: 70, title: "rename folder with 200 files", gap: "G7" },
  { row: 71, title: "rename folder carries B's extra file", gap: "G7" },
  { row: 72, title: "conflicting folder renames", gap: "G7, notice" },
  { row: 73, title: "move folder vs delete inside", gap: "G7" },
  { row: 74, title: "empty folder after moving files out", gap: "G8" },
  { row: 75, title: "(Dropbox app) deletes folder of 200 files" },

  // §10 A device joining or rejoining
  {
    row: 76,
    title: "fresh install, empty vault",
    gap: "G8",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const C = sim.addDevice("C");
      await A.editFile("note.md", "seed");
      await A.createFolder("Empty");
      await A.sync();
      await C.sync();
      expect(await C.readFile("note.md")).toBe("seed");
      expect(sim.remote.hasFolder("Empty")).toBe(true);
    },
  },
  {
    row: 77,
    title: "join with identical local copy",
    gap: "G4",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const C = sim.addDevice("C");
      await A.editFile("note.md", "same");
      await A.sync();
      await C.editFile("note.md", "same");
      await C.sync();
      expect(await C.findConflictSibling("note.md")).toBeUndefined();
      expect(await C.store.getEntry("note.md")).not.toBeNull();
    },
  },
  {
    row: 78,
    title: "join with stale local copy",
    gap: "G2",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const C = sim.addDevice("C");
      await A.editFile("note.md", "remote newer");
      await A.sync();
      await C.editFile("note.md", "stale local");
      await C.sync();
      expect(await C.readFile("note.md")).toBe("remote newer");
      expect(await C.findConflictSibling("note.md")).toBeDefined();
    },
  },
  {
    row: 79,
    title: "reinstall plugin, vault intact",
    gap: "G2",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      await A.editFile("note.md", "kept locally");
      await A.sync();
      // Simulate reinstall: new store, vault files intact.
      const reinstall = sim.addDevice("A2");
      await reinstall.editFile("note.md", "kept locally");
      await reinstall.sync();
      expect(await reinstall.readFile("note.md")).toBe("kept locally");
      expect(await reinstall.store.getEntry("note.md")).not.toBeNull();
    },
  },
  { row: 80, title: "repoint to different Dropbox folder", gap: "G15, G28" },
  {
    row: 81,
    title: "join vault maintained by Dropbox app",
    gap: "G1",
    run: async () => {
      const sim = new SyncSimulator();
      const app = sim.addDropboxAppDevice("Dropbox");
      const A = sim.addDevice("A");
      await app.upload("note.md", "app owned");
      await app.upload("note (Device x's conflicted copy 2026-07-26).md", "sibling");
      await A.sync();
      expect(A.hasFile("note.md")).toBe(true);
      expect(A.hasFile("note (Device x's conflicted copy 2026-07-26).md")).toBe(true);
    },
  },

  // §11 Deletes a device never saw
  {
    row: 82,
    title: "fresh join holds deleted file",
    gap: "G3",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const C = sim.addDevice("C");
      await A.editFile("note.md", "doomed");
      await A.sync();
      await A.deleteFile("note.md");
      await A.sync();
      await C.editFile("note.md", "doomed");
      await C.sync();
      // R10: deletion evidence → conflict copy, canonical path stays deleted.
      expect(C.hasFile("note.md")).toBe(false);
      expect(await C.findConflictSibling("note.md")).toBeDefined();
      expect(sim.remote.has("note.md")).toBe(false);
    },
  },
  { row: 83, title: "rejoin after deletion record expired", gap: "G3" },
  { row: 84, title: "fresh join with old vault, 200 deletes", gap: "G3" },
  { row: 85, title: "(Dropbox app) deleted 200 files months ago", gap: "G3" },

  // §12 File size and content type
  { row: 86, title: "400 MB attachment upload", gap: "chunked upload" },
  { row: 87, title: "400 MB attachment download on phone", gap: "streaming" },
  {
    row: 88,
    title: "binary file conflict",
    gap: "G2",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      const binA = new Uint8Array([1, 2, 3]);
      const binB = new Uint8Array([4, 5, 6]);
      await A.fs.write("pic.bin", binA);
      await A.sync();
      await B.sync();
      await A.fs.write("pic.bin", new Uint8Array([1, 2, 9]));
      await B.fs.write("pic.bin", binB);
      await A.sync();
      await B.sync();
      expect(await B.findConflictSibling("pic.bin")).toBeDefined();
    },
  },
  {
    row: 89,
    title: "creates zero-byte file",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("empty.md", "");
      await A.sync();
      await B.sync();
      expect(B.hasFile("empty.md")).toBe(true);
      expect(await B.readFile("empty.md")).toBe("");
      expect(sim.remote.has("empty.md")).toBe(true);
    },
  },
  { row: 90, title: "sync while large file still writing" },
  { row: 91, title: "first sync of 20,000 files", gap: "G28 cursor" },
  { row: 92, title: "attachment larger than free space", gap: "G17" },
  { row: 93, title: "(Dropbox app) 2 GB video on phone", gap: "streaming" },

  // §13 Interruptions and other cases
  { row: 94, title: "upload fails partway" },
  { row: 95, title: "download interrupted or corrupted", gap: "R7 temp file" },
  {
    row: 96,
    title: "modify excluded file",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A", { excludePatterns: ["secret/**"] });
      const B = sim.addDevice("B", { excludePatterns: ["secret/**"] });
      await A.editFile("note.md", "visible");
      await A.editFile("secret/hidden.md", "no sync");
      await A.sync();
      await B.sync();
      expect(B.hasFile("note.md")).toBe(true);
      expect(sim.remote.has("secret/hidden.md")).toBe(false);
    },
  },
  { row: 97, title: "defer conflict resolution", gap: "G10" },
  {
    row: 98,
    title: "delete propagated conflict copy",
    gap: "G1",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("note.md", "base");
      await A.sync();
      await B.sync();
      await A.editFile("note.md", "A");
      await B.editFile("note.md", "B");
      await A.sync();
      await B.sync();
      const conflictPath = await B.findConflictSibling("note.md");
      expect(conflictPath).toBeDefined();
      await A.sync();
      await B.deleteFile(conflictPath!);
      await B.sync();
      await A.sync();
      expect(A.hasFile(conflictPath!)).toBe(false);
      expect(sim.remote.has(conflictPath!)).toBe(false);
    },
  },
  {
    row: 99,
    title: "Dropbox invalidates change cursor",
    gap: "G28 deletion tombstone",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("note.md", "v1");
      await A.sync();
      await B.sync();
      await A.editFile("gone.md", "temp");
      await A.sync();
      await B.sync();
      await A.deleteFile("gone.md");
      await A.sync();
      sim.remote.invalidateCursor();
      await B.sync();
      expect(B.hasFile("gone.md")).toBe(false);
    },
  },
  { row: 100, title: "remote changes during sync cycle", gap: "G24, G29" },
  {
    row: 101,
    title: "notes-only vs full vault scope",
    gap: "G22, G28, G30",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      A.setSections(["notes"]);
      B.setSections(["notes"]);
      await A.editFile("note.md", "notes");
      await A.editFile(".obsidian/app.json", "{}");
      await A.sync();
      await B.sync();
      expect(B.hasFile("note.md")).toBe(true);
      expect(sim.remote.has(".obsidian/app.json")).toBe(false);
    },
  },
];

describe("sync scenario matrix (docs/sync-scenarios.md)", () => {
  let recordingLog: RecordingLog;

  beforeEach(() => {
    patchDeviceSettings({ deviceId: "test" });
    recordingLog = new RecordingLog();
    void recordingLog;
  });

  for (const scenario of SCENARIO_ROWS) {
    const label = `row ${scenario.row}: ${scenario.title}`;

    if (scenario.run) {
      test(label, scenario.run);
    } else if (scenario.gap) {
      test.todo(`${label} — gap ${scenario.gap}`, () => {});
    } else {
      test.todo(label, () => {});
    }
  }

  test("matrix covers rows 1–101", () => {
    expect(SCENARIO_ROWS).toHaveLength(101);
    expect(SCENARIO_ROWS.map((s) => s.row)).toEqual(
      Array.from({ length: 101 }, (_, i) => i + 1),
    );
  });

  test("RecordingLog captures sync monitor output", () => {
    const log = new RecordingLog();
    const syncLog = log.asSyncMonitorLog();
    syncLog("plan ready", { count: 1 }, {
      ruleId: "R2",
      category: "rule",
      hypothesisId: "sync",
      location: "test",
    });
    expect(log.findByRule("R2")).toHaveLength(1);
    expect(log.findByMessage("plan")).toHaveLength(1);
    log.clear();
    expect(log.records).toHaveLength(0);
  });
});
