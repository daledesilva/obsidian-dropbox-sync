import { describe, test, expect, beforeEach } from "bun:test";
import { patchDeviceSettings } from "@/device-settings/device-settings";
import { SyncSimulator, Device } from "../support/sync-simulator";

describe("2기기 동기화 시나리오", () => {
  let sim: SyncSimulator;
  let A: Device;
  let B: Device;

  beforeEach(() => {
    patchDeviceSettings({ deviceId: "test" });
    sim = new SyncSimulator();
    A = sim.addDevice("A");
    B = sim.addDevice("B");
  });

  test("기본 동기화: A 편집 → A sync → B sync → B에 반영", async () => {
    await A.editFile("note.md", "hello from A");
    await A.sync();
    await B.sync();

    expect(B.hasFile("note.md")).toBe(true);
    expect(await B.readFile("note.md")).toBe("hello from A");
  });

  test("양방향: A, B 다른 파일 편집 → sync → 양쪽 일치", async () => {
    await A.editFile("a.md", "content A");
    await B.editFile("b.md", "content B");

    await A.sync();
    await B.sync();
    // B가 sync하면 a.md 다운로드, b.md 업로드
    await A.sync();
    // A가 sync하면 b.md 다운로드

    expect(A.hasFile("a.md")).toBe(true);
    expect(A.hasFile("b.md")).toBe(true);
    expect(B.hasFile("a.md")).toBe(true);
    expect(B.hasFile("b.md")).toBe(true);

    await sim.assertAllConsistent();
  });

  test("충돌: A, B 같은 파일 편집 → 양쪽 보존", async () => {
    // 초기 동기화
    await A.editFile("note.md", "original");
    await A.sync();
    await B.sync();

    // 양쪽 수정
    await A.editFile("note.md", "version A");
    await B.editFile("note.md", "version B");

    await A.sync(); // A의 버전 업로드
    await B.sync(); // B에서 conflict 감지

    // B: canonical holds remote (A), conflict copy holds local (B) — R2
    expect(await B.readFile("note.md")).toBe("version A");
    const conflictPath = await B.findConflictSibling("note.md");
    expect(conflictPath).toBeDefined();
    expect(conflictPath).toMatch(/conflicted copy \d{4}-\d{2}-\d{2}/);
    expect(await B.readFile(conflictPath!)).toBe("version B");

    // G1: conflict copy propagates to Dropbox and the other device
    expect(sim.remote.has(conflictPath!)).toBe(true);
    await A.sync();
    expect(A.hasFile(conflictPath!)).toBe(true);
    expect(await A.readFile(conflictPath!)).toBe("version B");
  });

  test("삭제 전파: A 삭제 → B sync → B에서도 삭제", async () => {
    // 초기 동기화
    await A.editFile("note.md", "to delete");
    await A.sync();
    await B.sync();
    expect(B.hasFile("note.md")).toBe(true);

    // A에서 삭제
    await A.deleteFile("note.md");
    await A.sync();
    await B.sync();

    expect(B.hasFile("note.md")).toBe(false);
  });

  test("삭제 + 수정 교차: A 삭제 + B 편집 → B 변경 유지", async () => {
    // 초기 동기화
    await A.editFile("note.md", "original");
    await A.sync();
    await B.sync();

    // A 삭제 + B 수정
    await A.deleteFile("note.md");
    await B.editFile("note.md", "B edited");

    await A.sync(); // 원격에서 삭제됨
    await B.sync(); // B는 로컬 변경을 업로드 (변경 우선)

    // B에는 수정된 파일 유지
    expect(B.hasFile("note.md")).toBe(true);
    expect(await B.readFile("note.md")).toBe("B edited");

    // A가 다시 sync하면 B의 변경을 다운로드
    await A.sync();
    expect(A.hasFile("note.md")).toBe(true);
    expect(await A.readFile("note.md")).toBe("B edited");
  });

  test("순차 편집: A 편집 → sync → B 편집 → sync → A sync → 최신 반영", async () => {
    await A.editFile("note.md", "v1");
    await A.sync();
    await B.sync();

    await B.editFile("note.md", "v2");
    await B.sync();
    await A.sync();

    expect(await A.readFile("note.md")).toBe("v2");
    expect(await B.readFile("note.md")).toBe("v2");
  });

  test("여러 파일 동시 생성 → 양쪽 동기화", async () => {
    for (let i = 0; i < 5; i++) {
      await A.editFile(`a-${i}.md`, `A content ${i}`);
      await B.editFile(`b-${i}.md`, `B content ${i}`);
    }

    await A.sync();
    await B.sync();
    await A.sync();

    // A에 10개, B에 10개
    for (let i = 0; i < 5; i++) {
      expect(A.hasFile(`a-${i}.md`)).toBe(true);
      expect(A.hasFile(`b-${i}.md`)).toBe(true);
      expect(B.hasFile(`a-${i}.md`)).toBe(true);
      expect(B.hasFile(`b-${i}.md`)).toBe(true);
    }

    await sim.assertAllConsistent();
  });

  test("빈 파일 동기화", async () => {
    await A.editFile("empty.md", "");
    await A.sync();
    await B.sync();

    expect(B.hasFile("empty.md")).toBe(true);
    expect(await B.readFile("empty.md")).toBe("");
  });

  test("파일 덮어쓰기 후 동기화", async () => {
    await A.editFile("note.md", "v1");
    await A.sync();
    await B.sync();

    await A.editFile("note.md", "v2");
    await A.editFile("note.md", "v3"); // 연속 편집
    await A.sync();
    await B.sync();

    expect(await B.readFile("note.md")).toBe("v3");
  });
});

// ── manual 전략 ──

describe("2기기 동기화: manual 전략", () => {
  let sim: SyncSimulator;
  let A: Device;
  let B: Device;

  beforeEach(() => {
    patchDeviceSettings({ deviceId: "test" });
  });

  test("충돌: resolver가 local 선택 → remote canonical + local conflict copy", async () => {
    sim = new SyncSimulator();
    A = sim.addDevice("A", {
      conflictStrategy: "manual",
      conflictResolver: async () => "local",
    });
    B = sim.addDevice("B", {
      conflictStrategy: "manual",
      conflictResolver: async () => "local",
    });

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
  });

  test("충돌: resolver가 remote 선택 → remote canonical + local conflict copy", async () => {
    sim = new SyncSimulator();
    A = sim.addDevice("A", {
      conflictStrategy: "manual",
      conflictResolver: async () => "remote",
    });
    B = sim.addDevice("B", {
      conflictStrategy: "manual",
      conflictResolver: async () => "remote",
    });

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

    await A.sync();
    await sim.assertAllConsistent();
  });

  test("충돌: resolver가 merged 반환 → merged는 conflict copy", async () => {
    sim = new SyncSimulator();
    A = sim.addDevice("A", {
      conflictStrategy: "manual",
      conflictResolver: async (_path, ctx) => {
        const local = ctx?.localContent ?? "";
        const remote = ctx?.remoteContent ?? "";
        const merged = `${local}\n---\n${remote}`;
        return { type: "merged", content: new TextEncoder().encode(merged) };
      },
    });
    B = sim.addDevice("B", {
      conflictStrategy: "manual",
      conflictResolver: async (_path, ctx) => {
        const local = ctx?.localContent ?? "";
        const remote = ctx?.remoteContent ?? "";
        const merged = `${local}\n---\n${remote}`;
        return { type: "merged", content: new TextEncoder().encode(merged) };
      },
    });

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
    const conflictContent = await B.readFile(conflictPath!);
    expect(conflictContent).toContain("version B");
    expect(conflictContent).toContain("version A");
    expect(conflictContent).toContain("---");
  });

  test("충돌: resolver가 skip → keep_both fallback", async () => {
    sim = new SyncSimulator();
    A = sim.addDevice("A", {
      conflictStrategy: "manual",
      conflictResolver: async () => "local",
    });
    B = sim.addDevice("B", {
      conflictStrategy: "manual",
      conflictResolver: async () => "skip",
    });

    await A.editFile("note.md", "original");
    await A.sync();
    await B.sync();

    await A.editFile("note.md", "version A");
    await B.editFile("note.md", "version B");

    await A.sync();
    const result1 = await B.sync();
    expect(result1.result.deferred).toHaveLength(0);

    expect(await B.readFile("note.md")).toBe("version A");
    const conflictPath = await B.findConflictSibling("note.md");
    expect(conflictPath).toBeDefined();
    expect(await B.readFile(conflictPath!)).toBe("version B");
  });
});
