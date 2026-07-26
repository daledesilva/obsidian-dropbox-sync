import { describe, test, expect } from "bun:test";
import { SyncEngine } from "@/sync/engine";
import { MemoryFileSystem, MemoryRemoteStorage, MemoryStateStore } from "@/adapters/memory";

describe("CycleReport 통합 테스트", () => {
  function createEngine(options?: { onCycleReport?: (report: string, cycleId: string) => Promise<void> }) {
    const fs = new MemoryFileSystem();
    const remote = new MemoryRemoteStorage();
    const store = new MemoryStateStore();
    const engine = new SyncEngine(
      { fs, remote, store },
      {
        enableCycleReports: true,
        onCycleReport: options?.onCycleReport,
        resurrectionResolver: async () => "upload" as const,
      },
    );
    return { fs, remote, store, engine };
  }

  function parseReport(report: string): Record<string, unknown>[] {
    return report
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  test("enableCycleReports가 활성화되면 runCycle이 cycleReport를 반환한다", async () => {
    const { engine } = createEngine();
    const result = await engine.runCycle();

    expect(result.cycleReport).toBeDefined();
    expect(typeof result.cycleReport).toBe("string");
    expect(result.cycleReport!.length).toBeGreaterThan(0);
  });

  test("리포트에 cycle_start와 cycle_end 이벤트가 포함된다", async () => {
    const { engine } = createEngine();
    const result = await engine.runCycle();

    const events = parseReport(result.cycleReport!);
    const types = events.map((e) => e.type);

    expect(types).toContain("cycle_start");
    expect(types).toContain("cycle_end");

    // cycle_start가 첫 번째, cycle_end가 마지막
    expect(events[0].type).toBe("cycle_start");
    expect(events[events.length - 1].type).toBe("cycle_end");
  });

  test("파일이 있으면 리포트에 plan_decision 이벤트가 포함된다", async () => {
    const { fs, engine } = createEngine();

    // 로컬에 새 파일 추가
    await fs.write("note.md", new TextEncoder().encode("hello"));

    const result = await engine.runCycle();
    const events = parseReport(result.cycleReport!);
    const decisions = events.filter((e) => e.type === "plan_decision");

    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions[0].pathLower).toBe("note.md");
    expect(decisions[0].action).toBe("upload");
  });

  test("실행된 항목에 대해 exec_start와 exec_end 이벤트가 포함된다", async () => {
    const { fs, engine } = createEngine();

    await fs.write("doc.md", new TextEncoder().encode("content"));

    const result = await engine.runCycle();
    const events = parseReport(result.cycleReport!);

    const execStarts = events.filter((e) => e.type === "exec_start");
    const execEnds = events.filter((e) => e.type === "exec_end");

    expect(execStarts.length).toBeGreaterThan(0);
    expect(execEnds.length).toBeGreaterThan(0);

    // exec_start와 exec_end가 같은 pathLower를 가져야 한다
    expect(execStarts[0].pathLower).toBe("doc.md");
    expect(execEnds[0].pathLower).toBe("doc.md");
    expect(execEnds[0].ok).toBe(true);
  });

  test("onCycleReport 콜백이 리포트와 cycleId로 호출된다", async () => {
    let receivedReport: string | undefined;
    let receivedCycleId: string | undefined;

    const { fs, engine } = createEngine({
      onCycleReport: async (report, cycleId) => {
        receivedReport = report;
        receivedCycleId = cycleId;
      },
    });

    await fs.write("test.md", new TextEncoder().encode("data"));
    const result = await engine.runCycle();

    expect(receivedReport).toBeDefined();
    expect(receivedReport).toBe(result.cycleReport);
    expect(receivedCycleId).toBeDefined();
    expect(receivedCycleId).toMatch(/^cycle-/);
  });
});
