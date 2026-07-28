import { describe, test, expect, beforeEach } from "bun:test";
import { SyncSimulator, Device } from "../support/sync-simulator";
import {
  parseRetrySet,
  RETRY_SET_META_KEY,
} from "@/sync/retry-set";

describe("활성 파일 보호 시뮬레이션", () => {
  let sim: SyncSimulator;
  let A: Device;
  let B: Device;
  let bEditingActive: boolean;

  beforeEach(() => {
    sim = new SyncSimulator();
    A = sim.addDevice("A");
    bEditingActive = true;
    B = sim.addDevice("B", {
      isFileActive: (path) => bEditingActive && path === "editing.md",
    });
  });

  test("편집 중인 파일은 download에서 건너뛰고, 나머지는 정상 동기화", async () => {
    await A.editFile("editing.md", "from A");
    await A.editFile("other.md", "from A");
    await A.sync();

    const result = await B.sync();
    expect(B.hasFile("other.md")).toBe(true);
    expect(B.hasFile("editing.md")).toBe(false);
    expect(result.deferredCount).toBe(1);
  });

  test("활성 파일 비활성화 후 sync하면 정상 다운로드", async () => {
    await A.editFile("editing.md", "from A");
    await A.sync();

    const r1 = await B.sync();
    expect(r1.deferredCount).toBe(1);
    expect(B.hasFile("editing.md")).toBe(false);

    bEditingActive = false;
    const r2 = await B.sync();
    expect(B.hasFile("editing.md")).toBe(true);
    expect(r2.deferredCount).toBeUndefined();
  });

  test("G27: deferral advances cursor and durable retry applies after inactive", async () => {
    await A.editFile("editing.md", "version 1");
    await A.sync();

    const r1 = await B.sync();
    expect(r1.deferredCount).toBe(1);
    expect(r1.cursorUpdated).toBe(true);
    expect(B.hasFile("editing.md")).toBe(false);

    const retry = parseRetrySet(await B.store.getMeta(RETRY_SET_META_KEY));
    expect(retry.some((e) => e.localPath === "editing.md" && e.action.type === "download")).toBe(
      true,
    );

    bEditingActive = false;
    await B.sync();
    expect(B.hasFile("editing.md")).toBe(true);
    expect(await B.readFile("editing.md")).toBe("version 1");
  });
});
