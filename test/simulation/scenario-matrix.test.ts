import { describe, test, expect, beforeEach } from "bun:test";
import { SyncSimulator, isOfflineCycleResult } from "../support/sync-simulator";
import { RecordingLog } from "../support/recording-log";

type ScenarioRow = {
  row: number;
  title: string;
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
  { row: 3, title: "same path, same content", gap: "G4" },
  { row: 4, title: "same path, different content", gap: "G1, G2" },
  { row: 5, title: "three-way create conflict", gap: "G1, G2" },
  { row: 6, title: "three devices, identical content", gap: "G4" },
  { row: 7, title: "(Dropbox app) syncs" },

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
  { row: 10, title: "simultaneous different modifications", gap: "G2" },
  { row: 11, title: "modify to identical content", gap: "G4" },
  { row: 12, title: "three-way modify conflict", gap: "G1, G2" },
  { row: 13, title: "simultaneous upload rev rejection", gap: "G2" },
  { row: 14, title: "modify twice, sync after each" },
  { row: 15, title: "modify then long offline return", gap: "G2" },
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
  { row: 17, title: "(Dropbox app) simultaneous modify", gap: "G23" },

  // §3 Simultaneous editing
  { row: 18, title: "open editor, read-only on other device", gap: "G10" },
  { row: 19, title: "both typing, settled burst conflict", gap: "G18, G1, G2" },
  { row: 20, title: "three-way typing conflict", gap: "G1, G2" },
  { row: 21, title: "unsaved buffer on incoming change", gap: "G10, G27" },
  { row: 22, title: "continuous typing debounced" },
  { row: 23, title: "unsaved buffer after device sleep", gap: "G10, G27" },
  { row: 24, title: "unresolved conflict copy does not block note", gap: "G1" },
  { row: 25, title: "(Dropbox app) simultaneous typing", gap: "G23" },

  // §4 Deleting a file
  { row: 26, title: "deletes file, syncs", gap: "G3" },
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
  { row: 28, title: "delete while device offline for months", gap: "G28" },
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
  { row: 32, title: "delete then re-create same path" },
  { row: 33, title: "delete propagates to offline rejoin" },
  { row: 34, title: "(Dropbox app) deletes in Finder" },

  // §5 Delete crossed with edit
  { row: 35, title: "delete vs prior edit", gap: "notice" },
  { row: 36, title: "edit vs prior delete", gap: "notice" },
  { row: 37, title: "delete then edit restores file" },
  { row: 38, title: "double delete vs edit" },
  { row: 39, title: "delete vs two edits", gap: "G2" },
  { row: 40, title: "(Dropbox app) delete vs edit", gap: "notice" },

  // §6 Renaming and moving
  { row: 41, title: "rename old.md to new.md", gap: "G7" },
  { row: 42, title: "move file to different folder", gap: "G7" },
  { row: 43, title: "rename vs edit on old path", gap: "notice" },
  { row: 44, title: "conflicting renames", gap: "notice" },
  { row: 45, title: "platform-incompatible filename" },
  { row: 46, title: "(Dropbox app) renames in Finder", gap: "G7" },

  // §7 Capitalisation
  { row: 47, title: "rename note.md to Note.md", gap: "G6, C1" },
  { row: 48, title: "rename back to note.md", gap: "G6, C1" },
  { row: 49, title: "simultaneous case renames", gap: "G6" },
  { row: 50, title: "independent create, identical content, different case", gap: "G4, G6" },
  { row: 51, title: "independent create, different content, different case", gap: "G2, G6" },
  { row: 52, title: "case rename vs edit on old casing", gap: "G6" },
  { row: 53, title: "(Dropbox app) case rename in Finder", gap: "G6" },

  // §8 Folders and empty folders
  { row: 54, title: "creates empty Projects/ folder", gap: "G8" },
  { row: 55, title: "creates nested empty folders", gap: "G8" },
  { row: 56, title: "deletes empty folder", gap: "G8" },
  { row: 57, title: "renames empty folder", gap: "G8" },
  { row: 58, title: "conflicting folder casing", gap: "G8, G6" },
  { row: 59, title: "file vs folder name clash Draft", gap: "G8" },
  { row: 60, title: "folder with only excluded files", gap: "G8" },
  { row: 61, title: "empty folder then file inside" },
  { row: 62, title: "(Dropbox app) creates empty folder", gap: "G8" },

  // §9 Folders containing files
  { row: 63, title: "folder with file syncs" },
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
  { row: 76, title: "fresh install, empty vault", gap: "G8" },
  { row: 77, title: "join with identical local copy", gap: "G4" },
  { row: 78, title: "join with stale local copy", gap: "G2" },
  { row: 79, title: "reinstall plugin, vault intact", gap: "G2" },
  { row: 80, title: "repoint to different Dropbox folder", gap: "G15, G28" },
  { row: 81, title: "join vault maintained by Dropbox app", gap: "G1" },

  // §11 Deletes a device never saw
  { row: 82, title: "fresh join holds deleted file", gap: "G3" },
  { row: 83, title: "rejoin after deletion record expired", gap: "G3" },
  { row: 84, title: "fresh join with old vault, 200 deletes", gap: "G3" },
  { row: 85, title: "(Dropbox app) deleted 200 files months ago", gap: "G3" },

  // §12 File size and content type
  { row: 86, title: "400 MB attachment upload", gap: "chunked upload" },
  { row: 87, title: "400 MB attachment download on phone", gap: "streaming" },
  { row: 88, title: "binary file conflict", gap: "G2" },
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
  { row: 96, title: "modify excluded file" },
  { row: 97, title: "defer conflict resolution", gap: "G10" },
  { row: 98, title: "delete propagated conflict copy", gap: "G1" },
  { row: 99, title: "Dropbox invalidates change cursor", gap: "G28 deletion tombstone" },
  { row: 100, title: "remote changes during sync cycle", gap: "G24, G29" },
  { row: 101, title: "notes-only vs full vault scope", gap: "G22, G28, G30" },
];

describe("sync scenario matrix (docs/sync-scenarios.md)", () => {
  let recordingLog: RecordingLog;

  beforeEach(() => {
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
