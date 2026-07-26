import { describe, test, expect, beforeEach } from "bun:test";
import { SyncSimulator, Device } from "../support/sync-simulator";

describe("대량 파일 시나리오", () => {
  let sim: SyncSimulator;
  let A: Device;
  let B: Device;

  beforeEach(() => {
    sim = new SyncSimulator();
    A = sim.addDevice("A");
    B = sim.addDevice("B");
  });

  test("100개 파일 동시 생성 → sync → 전부 반영", async () => {
    for (let i = 0; i < 100; i++) {
      await A.editFile(`file-${i}.md`, `content ${i}`);
    }

    await A.sync();
    await B.sync();

    for (let i = 0; i < 100; i++) {
      expect(B.hasFile(`file-${i}.md`)).toBe(true);
      expect(await B.readFile(`file-${i}.md`)).toBe(`content ${i}`);
    }
  });

  test("50개 파일 수정 + 50개 삭제 → sync → 정확히 반영", async () => {
    // 100개 생성 + 동기화
    for (let i = 0; i < 100; i++) {
      await A.editFile(`file-${i}.md`, `original ${i}`);
    }
    await A.sync();
    await B.sync();

    // A: 0~49 수정, 50~99 삭제
    for (let i = 0; i < 50; i++) {
      await A.editFile(`file-${i}.md`, `modified ${i}`);
    }
    for (let i = 50; i < 100; i++) {
      await A.deleteFile(`file-${i}.md`);
    }

    await A.sync();
    await B.sync();

    // B: 0~49 수정됨, 50~99 삭제됨
    for (let i = 0; i < 50; i++) {
      expect(B.hasFile(`file-${i}.md`)).toBe(true);
      expect(await B.readFile(`file-${i}.md`)).toBe(`modified ${i}`);
    }
    for (let i = 50; i < 100; i++) {
      expect(B.hasFile(`file-${i}.md`)).toBe(false);
    }
  });

  test("양쪽에서 각각 50개 생성 → sync → 100개 일치", async () => {
    for (let i = 0; i < 50; i++) {
      await A.editFile(`a-${i}.md`, `A ${i}`);
      await B.editFile(`b-${i}.md`, `B ${i}`);
    }

    await A.sync();
    await B.sync();
    await A.sync();

    // 양쪽 모두 100개
    const aFiles = await A.fs.list();
    const bFiles = await B.fs.list();
    expect(aFiles).toHaveLength(100);
    expect(bFiles).toHaveLength(100);

    await sim.assertAllConsistent();
  });

  test("깊은 경로 파일 동기화", async () => {
    const deepPath = "level1/level2/level3/deep-note.md";
    await A.editFile(deepPath, "deep content");
    await A.sync();
    await B.sync();

    expect(B.hasFile(deepPath)).toBe(true);
    expect(await B.readFile(deepPath)).toBe("deep content");
  });

  test("연속 sync cycle: 변경 없으면 noop", async () => {
    await A.editFile("note.md", "content");
    await A.sync();
    await B.sync();

    // 변경 없이 다시 sync — may record base (G4) but no transfer actions
    const result = await A.sync();
    const transferItems = result.plan.items.filter(
      (i) => i.action.type !== "recordBase" && i.action.type !== "noop",
    );
    expect(transferItems).toHaveLength(0);
  });

  test("3기기 동기화", async () => {
    const C = sim.addDevice("C");

    await A.editFile("a.md", "from A");
    await B.editFile("b.md", "from B");
    await C.editFile("c.md", "from C");

    // 모든 기기 순차 sync
    await A.sync();
    await B.sync();
    await C.sync();

    // 2차 sync (모든 변경 전파)
    await A.sync();
    await B.sync();
    await C.sync();

    // 모든 기기에 3개 파일 존재
    for (const device of [A, B, C]) {
      expect(device.hasFile("a.md")).toBe(true);
      expect(device.hasFile("b.md")).toBe(true);
      expect(device.hasFile("c.md")).toBe(true);
    }

    await sim.assertAllConsistent();
  });

  test("concurrency=3: 100개 파일 병렬 동기화", async () => {
    const sim2 = new SyncSimulator();
    const A2 = sim2.addDevice("A", { concurrency: 3 });
    const B2 = sim2.addDevice("B", { concurrency: 3 });

    for (let i = 0; i < 100; i++) {
      await A2.editFile(`file-${i}.md`, `content ${i}`);
    }

    await A2.sync();
    await B2.sync();

    for (let i = 0; i < 100; i++) {
      expect(B2.hasFile(`file-${i}.md`)).toBe(true);
      expect(await B2.readFile(`file-${i}.md`)).toBe(`content ${i}`);
    }
  });
});
