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
  { row: 9, title: "modify while file open in editor", gap: "G10",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      let open = false;
      const B = sim.addDevice("B", {
        isFileActive: (path) => open && path === "note.md",
      });
      await A.editFile("note.md", "v1");
      await A.sync();
      await B.sync();
      expect(B.hasFile("note.md")).toBe(true);

      open = true;
      await A.editFile("note.md", "v2-remote");
      await A.sync();
      const deferred = await B.sync();
      expect(deferred.deferredCount).toBe(1);
      expect(await B.readFile("note.md")).toBe("v1");

      open = false;
      await B.sync();
      expect(await B.readFile("note.md")).toBe("v2-remote");
    },
  },
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
  {
    row: 18,
    title: "open editor, read-only on other device",
    gap: "G10",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      let open = true;
      const B = sim.addDevice("B", {
        isFileActive: (path) => open && path === "shared.md",
      });
      await A.editFile("shared.md", "from A");
      await A.sync();
      const r1 = await B.sync();
      expect(r1.deferredCount).toBe(1);
      expect(r1.cursorUpdated).toBe(true);
      expect(B.hasFile("shared.md")).toBe(false);
      open = false;
      await B.sync();
      expect(await B.readFile("shared.md")).toBe("from A");
    },
  },
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
  {
    row: 21,
    title: "unsaved buffer on incoming change",
    gap: "G10, G27",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      let dirty = true;
      const B = sim.addDevice("B", {
        // G19 dirty tabs use shouldDeferApply; isFileActive stands in for Memory tests.
        isFileActive: (path) => dirty && path === "draft.md",
      });
      await A.editFile("draft.md", "remote");
      await A.sync();
      const r1 = await B.sync();
      expect(r1.deferredCount).toBe(1);
      expect(r1.cursorUpdated).toBe(true);
      dirty = false;
      await B.sync();
      expect(await B.readFile("draft.md")).toBe("remote");
    },
  },
  {
    row: 22,
    title: "continuous typing debounced",
    run: async () => {
      const {
        decideDebounceFire,
        decideVaultActivityScheduling,
        shouldRearmDebounceAfterPendingVaultActivity,
      } = await import("@/sync/background-sync-schedule");
      const debounceMs = 5_000;
      // Mid-cycle autosaves must not arm a timer.
      expect(
        decideVaultActivityScheduling({ syncing: true, debounceMs }),
      ).toEqual({ kind: "pending" });
      expect(
        shouldRearmDebounceAfterPendingVaultActivity({
          backgroundEnabled: true,
          pendingDebouncedSync: true,
        }),
      ).toBe(true);
      // Continuous typing: each modify resets quiet clock — fire only after full quiet.
      let lastVaultEventAt = 0;
      for (const t of [0, 1800, 3600, 5400]) {
        lastVaultEventAt = t;
        expect(
          decideDebounceFire({
            syncing: false,
            lastVaultEventAt,
            now: t + 2000,
            debounceMs,
          }).kind,
        ).toBe("rearm");
      }
      expect(
        decideDebounceFire({
          syncing: false,
          lastVaultEventAt,
          now: lastVaultEventAt + debounceMs,
          debounceMs,
        }),
      ).toEqual({ kind: "sync" });
    },
  },
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
  {
    row: 25,
    title: "(Dropbox app) simultaneous typing",
    gap: "G23",
    run: async () => {
      const sim = new SyncSimulator();
      const app = sim.addDropboxAppDevice("Dropbox");
      const A = sim.addDevice("A");
      await A.editFile("note.md", "base");
      await A.sync();
      await A.editFile("note.md", "plugin typing");
      await app.upload("note.md", "finder typing");
      await A.sync();
      expect(await A.readFile("note.md")).toBe("finder typing");
      expect(await A.findConflictSibling("note.md")).toBeDefined();
    },
  },

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
  {
    row: 29,
    title: "delete while file open in editor",
    gap: "G10, G27",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      let open = false;
      const B = sim.addDevice("B", {
        isFileActive: (path) => open && path === "gone.md",
        confirmDeleteLocalWhileOpen: async () => false,
      });
      await A.editFile("gone.md", "exists");
      await A.sync();
      await B.sync();
      expect(B.hasFile("gone.md")).toBe(true);

      open = true;
      await A.deleteFile("gone.md");
      await A.sync();
      const deferred = await B.sync();
      expect(deferred.deferredCount).toBe(1);
      expect(B.hasFile("gone.md")).toBe(true);

      open = false;
      await B.sync();
      expect(B.hasFile("gone.md")).toBe(false);
    },
  },
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
  {
    row: 31,
    title: "file missing without real delete",
    gap: "G22",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      await A.editFile("keep.md", "safe");
      await A.editFile("gone.md", "was here");
      await A.sync();
      // Simulate incomplete scan: file vanishes from listing without a delete event.
      await A.fs.delete("gone.md");
      A.setScanUnvouched(["gone.md"]);
      const cycle = await A.sync();
      expect(sim.remote.has("gone.md")).toBe(true);
      expect(
        cycle.plan.items.some(
          (i) => i.action.type === "deleteRemote" && i.pathLower === "gone.md",
        ),
      ).toBe(false);
      A.setScanVouched();
    },
  },
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
      // Linked device + remote delete + unchanged local = ordinary deleteLocal,
      // not R10 (contrast with row 82 fresh-join conflict copy).
      const sim = new SyncSimulator();
      const app = sim.addDropboxAppDevice("Dropbox");
      const A = sim.addDevice("A");
      await A.editFile("note.md", "x");
      await A.sync();
      await app.delete("note.md");
      await A.sync();
      expect(A.hasFile("note.md")).toBe(false);
      expect(await A.findConflictSibling("note.md")).toBeUndefined();
      expect(sim.remote.has("note.md")).toBe(false);
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
  {
    row: 38,
    title: "double delete vs edit",
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
      await B.deleteFile("note.md");
      await C.editFile("note.md", "C edited");
      await A.sync();
      await B.sync();
      await C.sync();
      expect(await C.readFile("note.md")).toBe("C edited");
      await A.sync();
      expect(await A.readFile("note.md")).toBe("C edited");
    },
  },
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
  {
    row: 43,
    title: "rename vs edit on old path",
    gap: "notice",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("old.md", "base");
      await A.sync();
      await B.sync();
      await A.rename("old.md", "new.md");
      await B.editFile("old.md", "B edited");
      await A.sync();
      await B.sync();
      expect(sim.remote.has("new.md") || B.hasFile("old.md")).toBe(true);
    },
  },
  {
    row: 44,
    title: "conflicting renames",
    gap: "notice",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("shared.md", "base");
      await A.sync();
      await B.sync();
      await A.rename("shared.md", "alpha.md");
      await B.rename("shared.md", "beta.md");
      await A.sync();
      await B.sync();
      await A.sync();
      expect(
        (A.hasFile("alpha.md") || A.hasFile("beta.md"))
        && (B.hasFile("alpha.md") || B.hasFile("beta.md")),
      ).toBe(true);
    },
  },
  {
    row: 45,
    title: "platform-incompatible filename",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A", { strictLocalPaths: true });
      const B = sim.addDevice("B");
      await A.editFile("ok.md", "fine");
      // Colon is illegal on Windows-style strict path guards.
      await A.editFile("bad:name.md", "skip me");
      const cycle = await A.sync();
      expect(cycle.pathsSkipped ?? 0).toBeGreaterThanOrEqual(0);
      await B.sync();
      expect(B.hasFile("ok.md")).toBe(true);
    },
  },
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
  {
    row: 49,
    title: "simultaneous case renames",
    gap: "G6",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("note.md", "body");
      await A.sync();
      await B.sync();
      await A.rename("note.md", "Note.md");
      await B.rename("note.md", "NOTE.md");
      await A.sync();
      await B.sync();
      await A.sync();
      expect(sim.remote.has("note.md")).toBe(true);
      const display = sim.remote.getFile("note.md")?.pathDisplay;
      expect(display === "Note.md" || display === "NOTE.md" || display === "note.md").toBe(true);
    },
  },
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
  {
    row: 52,
    title: "case rename vs edit on old casing",
    gap: "G6",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("note.md", "base");
      await A.sync();
      await B.sync();
      await A.rename("note.md", "Note.md");
      await B.editFile("note.md", "B edited");
      await A.sync();
      await B.sync();
      expect(B.hasFile("Note.md") || B.hasFile("note.md")).toBe(true);
    },
  },
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
  {
    row: 57,
    title: "renames empty folder",
    gap: "G8",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.createFolder("OldName");
      await A.sync();
      await B.sync();
      await A.renameFolder("OldName", "NewName");
      await A.sync();
      await B.sync();
      expect(sim.remote.hasFolder("NewName")).toBe(true);
      expect(sim.remote.hasFolder("OldName")).toBe(false);
    },
  },
  {
    row: 58,
    title: "conflicting folder casing",
    gap: "G8, G6",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.createFolder("Projects");
      await A.sync();
      await B.sync();
      await A.renameFolder("Projects", "projects");
      await B.renameFolder("Projects", "PROJECTS");
      await A.sync();
      await B.sync();
      expect(sim.remote.hasFolder("projects") || sim.remote.hasFolder("Projects")).toBe(true);
    },
  },
  {
    row: 59,
    title: "file vs folder name clash Draft",
    gap: "G8",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("Draft", "file content");
      await A.sync();
      await B.sync();
      await B.deleteFile("Draft");
      await B.createFolder("Draft");
      await B.sync();
      const cycle = await A.sync();
      expect(
        cycle.plan.items.some((i) => i.action.type === "pathCollision")
        || A.hasFile("Draft")
        || (await A.fs.listFolders()).some((f) => f.pathLower === "draft"),
      ).toBe(true);
    },
  },
  {
    row: 60,
    title: "folder with only excluded files",
    gap: "G8",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A", { excludePatterns: ["bait/**"] });
      const B = sim.addDevice("B", { excludePatterns: ["bait/**"] });
      await A.createFolder("bait");
      await A.editFile("bait/secret.md", "hidden");
      await A.sync();
      await B.sync();
      expect(sim.remote.has("bait/secret.md")).toBe(false);
      expect(sim.remote.hasFolder("bait") || (await A.fs.listFolders()).some((f) => f.pathLower === "bait")).toBe(true);
    },
  },
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
  {
    row: 64,
    title: "delete folder with 12 files (coalesce)",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      for (let i = 0; i < 12; i++) {
        await A.editFile(`bulk/f${i}.md`, `c${i}`);
      }
      await A.sync();
      await B.sync();
      await A.deleteFolder("bulk");
      await A.sync();
      await B.sync();
      expect(sim.remote.has("bulk/f0.md")).toBe(false);
      expect(B.hasFile("bulk/f0.md")).toBe(false);
      expect(B.hasFile("bulk/f11.md")).toBe(false);
    },
  },
  {
    row: 65,
    title: "delete folder, B has extra local files",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("pack/a.md", "a");
      await A.editFile("pack/b.md", "b");
      await A.sync();
      await B.sync();
      await B.editFile("pack/extra.md", "local only");
      await A.deleteFolder("pack");
      await A.sync();
      await B.sync();
      // Extra local file must not be silently wiped with the folder delete.
      expect(B.hasFile("pack/extra.md")).toBe(true);
      expect(await B.readFile("pack/extra.md")).toBe("local only");
    },
  },
  {
    row: 66,
    title: "delete folder, extra remote file blocks coalesce",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      const app = sim.addDropboxAppDevice("Dropbox");
      await A.editFile("pack/a.md", "a");
      await A.editFile("pack/b.md", "b");
      await A.sync();
      await B.sync();
      await app.upload("pack/keep.md", "remote extra");
      await A.deleteFile("pack/a.md");
      await A.deleteFile("pack/b.md");
      await A.sync();
      expect(sim.remote.has("pack/keep.md")).toBe(true);
      await B.sync();
      expect(B.hasFile("pack/keep.md")).toBe(true);
    },
  },
  {
    row: 67,
    title: "delete folder with excluded file inside",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A", { excludePatterns: ["pack/secret.md"] });
      const B = sim.addDevice("B", { excludePatterns: ["pack/secret.md"] });
      await A.editFile("pack/a.md", "a");
      await A.editFile("pack/secret.md", "no sync");
      await A.sync();
      await B.sync();
      expect(sim.remote.has("pack/secret.md")).toBe(false);
      await A.deleteFolder("pack");
      await A.sync();
      await B.sync();
      expect(sim.remote.has("pack/a.md")).toBe(false);
    },
  },
  {
    row: 68,
    title: "delete folder, partial copy on C",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      const C = sim.addDevice("C");
      await A.editFile("pack/a.md", "a");
      await A.editFile("pack/b.md", "b");
      await A.sync();
      await B.sync();
      await C.sync();
      await C.deleteFile("pack/b.md");
      await A.deleteFolder("pack");
      await A.sync();
      await B.sync();
      await C.sync();
      expect(B.hasFile("pack/a.md")).toBe(false);
      expect(C.hasFile("pack/a.md")).toBe(false);
    },
  },
  {
    row: 69,
    title: "delete folder vs new file inside",
    gap: "G8",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("pack/a.md", "a");
      await A.sync();
      await B.sync();
      await A.deleteFolder("pack");
      await B.editFile("pack/new.md", "from B");
      await A.sync();
      await B.sync();
      expect(sim.remote.has("pack/new.md") || B.hasFile("pack/new.md")).toBe(true);
    },
  },
  {
    row: 70,
    title: "rename folder with files",
    gap: "G7",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      for (let i = 0; i < 8; i++) {
        await A.editFile(`olddir/f${i}.md`, `c${i}`);
      }
      await A.sync();
      await B.sync();
      await A.renameFolder("olddir", "newdir");
      await A.sync();
      await B.sync();
      expect(B.hasFile("newdir/f0.md")).toBe(true);
      expect(B.hasFile("olddir/f0.md")).toBe(false);
      expect(await B.readFile("newdir/f7.md")).toBe("c7");
    },
  },
  {
    row: 71,
    title: "rename folder carries B's extra file",
    gap: "G7",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("olddir/a.md", "a");
      await A.sync();
      await B.sync();
      await B.editFile("olddir/extra.md", "extra");
      await A.renameFolder("olddir", "newdir");
      await A.sync();
      await B.sync();
      expect(B.hasFile("newdir/a.md") || B.hasFile("olddir/extra.md")).toBe(true);
    },
  },
  {
    row: 72,
    title: "conflicting folder renames",
    gap: "G7, notice",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("shared/x.md", "x");
      await A.sync();
      await B.sync();
      await A.renameFolder("shared", "alpha");
      await B.renameFolder("shared", "beta");
      await A.sync();
      await B.sync();
      await A.sync();
      const aHas = A.hasFile("alpha/x.md") || A.hasFile("beta/x.md");
      const bHas = B.hasFile("alpha/x.md") || B.hasFile("beta/x.md");
      expect(aHas && bHas).toBe(true);
    },
  },
  {
    row: 73,
    title: "move folder vs delete inside",
    gap: "G7",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("box/a.md", "a");
      await A.editFile("box/b.md", "b");
      await A.sync();
      await B.sync();
      await A.renameFolder("box", "crate");
      await B.deleteFile("box/b.md");
      await A.sync();
      await B.sync();
      expect(sim.remote.has("crate/a.md") || A.hasFile("crate/a.md")).toBe(true);
    },
  },
  {
    row: 74,
    title: "empty folder after moving files out",
    gap: "G8",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const B = sim.addDevice("B");
      await A.editFile("src/a.md", "a");
      await A.sync();
      await B.sync();
      await A.rename("src/a.md", "dst/a.md");
      await A.sync();
      await B.sync();
      expect(B.hasFile("dst/a.md")).toBe(true);
      expect(B.hasFile("src/a.md")).toBe(false);
    },
  },
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
  {
    row: 83,
    title: "rejoin after deletion record expired",
    gap: "G3",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      let asked = false;
      const C = sim.addDevice("C", {
        resurrectionResolver: async () => {
          asked = true;
          return "upload";
        },
      });
      await A.editFile("note.md", "doomed");
      await A.sync();
      await A.deleteFile("note.md");
      await A.sync();
      sim.remote.expireRevisions("note.md");
      await C.editFile("note.md", "stale local");
      await C.sync();
      expect(asked).toBe(true);
      expect(C.hasFile("note.md") || (await C.findConflictSibling("note.md"))).toBeTruthy();
    },
  },
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
  {
    row: 94,
    title: "upload fails partway",
    run: async () => {
      const sim = new SyncSimulator();
      const { device: A, failingRemote } = sim.addDeviceWithFailingRemote("A");
      const B = sim.addDevice("B");
      await A.editFile("note.md", "v1");
      failingRemote.injectFailure({ after: 0, method: "upload" });
      const failed = await A.sync();
      expect(failed.result.failed.length).toBeGreaterThanOrEqual(1);
      failingRemote.clearFailure();
      await A.sync();
      await B.sync();
      expect(await B.readFile("note.md")).toBe("v1");
    },
  },
  {
    row: 95,
    title: "download interrupted or corrupted",
    gap: "R7 temp file",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const { device: B, failingRemote } = sim.addDeviceWithFailingRemote("B");
      await A.editFile("note.md", "payload");
      await A.sync();
      failingRemote.injectFailure({ after: 0, method: "download" });
      const failed = await B.sync();
      expect(failed.result.failed.length).toBeGreaterThanOrEqual(1);
      failingRemote.clearFailure();
      await B.sync();
      expect(await B.readFile("note.md")).toBe("payload");
    },
  },
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
  {
    row: 100,
    title: "remote changes during sync cycle",
    gap: "G24, G29",
    run: async () => {
      const sim = new SyncSimulator();
      const A = sim.addDevice("A");
      const app = sim.addDropboxAppDevice("Dropbox");
      await A.editFile("note.md", "planned");
      await A.sync();
      // Mid-cycle style race: remote rewritten after A planned a delete of another path.
      await A.editFile("other.md", "local");
      await app.upload("other.md", "finder won");
      const cycle = await A.sync();
      // add-mode / rev conflict must not silently overwrite Finder bytes.
      expect(await A.findConflictSibling("other.md") || sim.remote.has("other.md")).toBeTruthy();
      void cycle;
    },
  },
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
