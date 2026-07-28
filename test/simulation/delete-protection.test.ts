import { describe, test, expect } from "bun:test";
import { SyncSimulator } from "../support/sync-simulator";

describe("삭제 보호", () => {
  // ── 레이어 1: 삭제 이벤트 추적 ──

  test("의도된 삭제 → 원격 삭제 전파", async () => {
    const sim = new SyncSimulator();
    const a = sim.addDevice("A");
    const b = sim.addDevice("B");

    // 초기: A에서 파일 생성 → sync → B sync
    await a.editFile("note.md", "content");
    await a.sync();
    await b.sync();
    expect(b.hasFile("note.md")).toBe(true);

    // A에서 삭제 (deleteFile은 삭제 로그 자동 기록)
    await a.deleteFile("note.md");
    await a.sync();

    // B sync → 로컬 삭제 전파
    await b.sync();
    expect(b.hasFile("note.md")).toBe(false);
  });

  test("삭제 이벤트 누락 → catch-up이 삭제 의도 감지 → deleteRemote", async () => {
    const sim = new SyncSimulator();
    const a = sim.addDevice("A");

    // 파일 생성 + 동기화
    await a.editFile("note.md", "content");
    await a.sync();

    // 직접 fs에서 삭제 (삭제 이벤트 미기록 — 모바일 vault 이벤트 누락 시뮬레이션)
    await a.fs.delete("note.md");
    // 삭제 로그에 기록하지 않음!

    // sync → catch-up이 감지 → deleteRemote
    const { plan } = await a.sync();
    const actions = plan.items.filter((i) => i.pathLower === "note.md");
    expect(actions).toHaveLength(1);
    expect(actions[0].action.type).toBe("deleteRemote");
    expect(sim.remote.has("note.md")).toBe(false);
  });

  test("삭제 후 sync 전에 앱 재시작 (삭제 로그 복원)", async () => {
    const sim = new SyncSimulator();
    const a = sim.addDevice("A");

    // 파일 생성 + 동기화
    await a.editFile("note.md", "content");
    await a.sync();

    // 삭제
    await a.deleteFile("note.md");

    // 삭제 로그 저장 → 새 엔진에 복원
    const log = a.engine.getDeleteLog();
    expect(log).toContain("note.md");

    // 새 device로 엔진 복원 시뮬레이션
    // (실제로는 같은 engine이므로 log가 이미 있음)
    a.engine.restoreDeleteLog(log);

    // sync → deleteRemote 실행
    await a.sync();
    expect(sim.remote.has("note.md")).toBe(false);
  });

  // ── 레이어 2: 대량 삭제 가드 ──

  test("대량 삭제 → 가드 차단 (삭제만 스킵)", async () => {
    const sim = new SyncSimulator();
    const a = sim.addDevice("A", {
      deleteProtection: true,
      deleteThreshold: 2,
      // onDeleteGuardTriggered 미제공 → 자동 스킵
    });

    // 5개 파일 생성 + 동기화
    for (let i = 0; i < 5; i++) {
      await a.editFile(`file${i}.md`, `content ${i}`);
    }
    await a.sync();

    // 5개 모두 삭제
    for (let i = 0; i < 5; i++) {
      await a.deleteFile(`file${i}.md`);
    }

    // sync → 가드 차단, 삭제 스킵
    const { deletesSkipped } = await a.sync();
    expect(deletesSkipped).toBe(5);

    // 원격에는 파일이 남아있음
    for (let i = 0; i < 5; i++) {
      expect(sim.remote.has(`file${i}.md`)).toBe(true);
    }
  });

  test("대량 삭제 → 가드 승인 시 실행", async () => {
    const sim = new SyncSimulator();
    const a = sim.addDevice("A", {
      deleteProtection: true,
      deleteThreshold: 2,
      onDeleteGuardTriggered: async () => true, // 사용자 승인
    });

    // 3개 파일 생성 + 동기화
    for (let i = 0; i < 3; i++) {
      await a.editFile(`file${i}.md`, `content ${i}`);
    }
    await a.sync();

    // 3개 모두 삭제
    for (let i = 0; i < 3; i++) {
      await a.deleteFile(`file${i}.md`);
    }

    // sync → 사용자 승인 → 삭제 실행
    const { deletesSkipped } = await a.sync();
    expect(deletesSkipped).toBe(0);

    // 원격에서도 삭제됨
    for (let i = 0; i < 3; i++) {
      expect(sim.remote.has(`file${i}.md`)).toBe(false);
    }
  });

  test("소량 삭제 → 가드 통과", async () => {
    const sim = new SyncSimulator();
    const a = sim.addDevice("A", {
      deleteProtection: true,
      deleteThreshold: 5,
    });

    // 2개 파일 생성 + 동기화
    await a.editFile("a.md", "a");
    await a.editFile("b.md", "b");
    await a.sync();

    // 2개 삭제 (threshold=5 미만)
    await a.deleteFile("a.md");
    await a.deleteFile("b.md");

    const { deletesSkipped } = await a.sync();
    expect(deletesSkipped).toBe(0);

    // 정상 삭제됨
    expect(sim.remote.has("a.md")).toBe(false);
    expect(sim.remote.has("b.md")).toBe(false);
  });

  // ── rename 시나리오 ──

  test("rename → 구경로 삭제 + 신경로 업로드", async () => {
    const sim = new SyncSimulator();
    const a = sim.addDevice("A");
    const b = sim.addDevice("B");

    // 파일 생성 + 동기화
    await a.editFile("old-name.md", "content");
    await a.sync();
    await b.sync();

    // A에서 rename 시뮬레이션: 구경로 삭제(이벤트 기록) + 신경로 생성
    await a.deleteFile("old-name.md"); // trackDelete 자동
    await a.editFile("new-name.md", "content");
    await a.sync();

    // A: 구경로 없음, 신경로 있음
    expect(a.hasFile("old-name.md")).toBe(false);
    expect(a.hasFile("new-name.md")).toBe(true);

    // B sync → 구경로 삭제 전파 + 신경로 다운로드
    await b.sync();
    expect(b.hasFile("old-name.md")).toBe(false);
    expect(b.hasFile("new-name.md")).toBe(true);
    expect(await b.readFile("new-name.md")).toBe("content");
  });

  // ── 멀티 디바이스 ──

  test("Device B에서 삭제 → Device A는 기존 delta 로직으로 처리", async () => {
    const sim = new SyncSimulator();
    const a = sim.addDevice("A");
    const b = sim.addDevice("B");

    // 초기 동기화
    await a.editFile("shared.md", "content");
    await a.sync();
    await b.sync();

    // B에서 삭제 + sync → 원격 삭제
    await b.deleteFile("shared.md");
    await b.sync();

    // A sync → delta에서 삭제 감지 → deleteLocal
    await a.sync();
    expect(a.hasFile("shared.md")).toBe(false);
  });

  // ── 가드 비활성화 ──

  test("deleteProtection=false → 대량 삭제도 바로 실행", async () => {
    const sim = new SyncSimulator();
    const a = sim.addDevice("A", {
      deleteProtection: false,
      deleteThreshold: 2,
    });

    // 10개 파일 생성 + 동기화
    for (let i = 0; i < 10; i++) {
      await a.editFile(`file${i}.md`, `content ${i}`);
    }
    await a.sync();

    // 10개 모두 삭제
    for (let i = 0; i < 10; i++) {
      await a.deleteFile(`file${i}.md`);
    }

    const { deletesSkipped } = await a.sync();
    expect(deletesSkipped).toBe(0);

    for (let i = 0; i < 10; i++) {
      expect(sim.remote.has(`file${i}.md`)).toBe(false);
    }
  });

  // ── Thread regressions: cursor hold, tree wipe, keep empty ──

  test("Skip remote deletes holds cursor and re-prompts next sync", async () => {
    // Remote-originated deletes do not inflate the local delete log — cursor hold
    // must rely on deletesSkipped (the deferred-commit regression).
    const sim = new SyncSimulator();
    const a = sim.addDevice("A", {
      deleteProtection: true,
      deleteThreshold: 2,
      // no onDeleteGuardTriggered → auto skip
    });
    const b = sim.addDevice("B");

    for (let i = 0; i < 5; i++) {
      await a.editFile(`shared${i}.md`, `c${i}`);
    }
    await a.sync();
    await b.sync();

    for (let i = 0; i < 5; i++) {
      await b.deleteFile(`shared${i}.md`);
    }
    await b.sync();

    const first = await a.sync();
    expect(first.deletesSkipped).toBe(5);
    expect(first.cursorUpdated).toBe(false);
    for (let i = 0; i < 5; i++) {
      expect(a.hasFile(`shared${i}.md`)).toBe(true);
    }

    const second = await a.sync();
    expect(second.deletesSkipped).toBe(5);
    expect(second.cursorUpdated).toBe(false);
    for (let i = 0; i < 5; i++) {
      expect(a.hasFile(`shared${i}.md`)).toBe(true);
    }
  });

  test("local folder tree wipe clears remote folder shell", async () => {
    const sim = new SyncSimulator();
    const a = sim.addDevice("A", {
      deleteProtection: true,
      deleteThreshold: 5,
      onDeleteGuardTriggered: async () => true,
    });

    await a.createFolder("tree");
    await a.editFile("tree/a.md", "a");
    await a.editFile("tree/b.md", "b");
    await a.sync();
    expect(sim.remote.has("tree/a.md")).toBe(true);
    expect(sim.remote.hasFolder("tree")).toBe(true);

    await a.deleteFile("tree/a.md");
    await a.deleteFile("tree/b.md");
    await a.deleteFolder("tree");
    await a.sync();

    expect(sim.remote.has("tree/a.md")).toBe(false);
    expect(sim.remote.has("tree/b.md")).toBe(false);
    expect(sim.remote.hasFolder("tree")).toBe(false);
  });

  test("remote folder tree wipe clears local folder same cycle", async () => {
    const sim = new SyncSimulator();
    const a = sim.addDevice("A", {
      deleteProtection: true,
      deleteThreshold: 5,
      onDeleteGuardTriggered: async () => true,
    });
    const app = sim.addDropboxAppDevice("Dropbox");

    await a.createFolder("tree");
    await a.editFile("tree/a.md", "a");
    await a.editFile("tree/b.md", "b");
    await a.sync();

    await app.delete("tree/a.md");
    await app.delete("tree/b.md");
    await app.deleteFolder("tree");

    await a.sync();

    expect(a.hasFile("tree/a.md")).toBe(false);
    expect(a.hasFile("tree/b.md")).toBe(false);
    const folders = await a.fs.listFolders();
    expect(folders.some((f) => f.pathLower === "tree")).toBe(false);
  });

  test("delete children only — empty folder kept both sides", async () => {
    const sim = new SyncSimulator();
    const a = sim.addDevice("A", {
      deleteProtection: true,
      deleteThreshold: 5,
      onDeleteGuardTriggered: async () => true,
    });
    const b = sim.addDevice("B");

    await a.createFolder("bulk");
    await a.editFile("bulk/a.md", "a");
    await a.editFile("bulk/b.md", "b");
    await a.sync();
    await b.sync();

    await a.deleteFile("bulk/a.md");
    await a.deleteFile("bulk/b.md");
    await a.sync();
    await b.sync();

    expect(sim.remote.has("bulk/a.md")).toBe(false);
    expect(sim.remote.has("bulk/b.md")).toBe(false);
    expect(sim.remote.hasFolder("bulk")).toBe(true);
    expect((await a.fs.listFolders()).some((f) => f.pathLower === "bulk")).toBe(true);
    expect((await b.fs.listFolders()).some((f) => f.pathLower === "bulk")).toBe(true);
  });
});
