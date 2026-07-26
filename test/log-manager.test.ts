import { describe, test, expect, beforeEach, mock } from "bun:test";
import { LogManager, type LogStorage } from "@/log-manager";

function createStorage(): LogStorage & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    exists: async (path) => files.has(path),
    read: async (path) => files.get(path) ?? "",
    write: async (path, data) => { files.set(path, data); },
  };
}

describe("LogManager", () => {
  let storage: ReturnType<typeof createStorage>;
  let logger: LogManager;

  beforeEach(() => {
    storage = createStorage();
    logger = new LogManager(storage, () => "test.log", { consoleOutput: false });
  });

  test("log + flush → 파일에 기록", async () => {
    await logger.log("hello");
    await logger.flush();

    const content = storage.files.get("test.log")!;
    expect(content).toContain("hello");
    expect(content).toMatch(/^\[.*\] hello\n$/);
  });

  test("flushSize 도달 시 자동 flush", async () => {
    const small = new LogManager(storage, () => "test.log", { maxLines: 200, flushSize: 3, consoleOutput: false });
    await small.log("a");
    await small.log("b");
    expect(storage.files.has("test.log")).toBe(false);

    await small.log("c"); // 3번째 → flush
    expect(storage.files.has("test.log")).toBe(true);
    const content = storage.files.get("test.log")!;
    expect(content.split("\n").filter(Boolean)).toHaveLength(3);
  });

  test("maxLines 초과 시 오래된 로그 삭제", async () => {
    const tiny = new LogManager(storage, () => "test.log", { maxLines: 5, flushSize: 1, consoleOutput: false });
    for (let i = 0; i < 10; i++) {
      await tiny.log(`line-${i}`);
    }
    await tiny.flush();

    const content = storage.files.get("test.log")!;
    const lines = content.split("\n").filter(Boolean);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("line-5");
    expect(lines[4]).toContain("line-9");
  });

  test("read → flush 후 파일 내용 반환", async () => {
    await logger.log("test message");
    const content = await logger.read();
    expect(content).toContain("test message");
  });

  test("read → 파일 없으면 (no logs)", async () => {
    const content = await logger.read();
    expect(content).toBe("(no logs)");
  });

  test("flush → 빈 버퍼면 아무것도 안 함", async () => {
    await logger.flush();
    expect(storage.files.has("test.log")).toBe(false);
  });

  test("log → Error 객체 포맷팅", async () => {
    const err = new Error("boom");
    err.name = "TestError";
    await logger.log("failed", err);
    await logger.flush();

    const content = storage.files.get("test.log")!;
    expect(content).toContain("TestError: boom");
  });

  test("log → 일반 데이터 JSON 직렬화", async () => {
    await logger.log("info", { key: "value" });
    await logger.flush();

    const content = storage.files.get("test.log")!;
    expect(content).toContain('{"key":"value"}');
  });

  test("기존 로그에 이어 쓰기", async () => {
    storage.files.set("test.log", "[old] first\n");
    await logger.log("second");
    await logger.flush();

    const content = storage.files.get("test.log")!;
    const lines = content.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("[old] first");
    expect(lines[1]).toContain("second");
  });

  test("logPath 동적 변경 반영", async () => {
    let path = "a.log";
    const dynamic = new LogManager(storage, () => path, { consoleOutput: false });
    await dynamic.log("msg-a");
    await dynamic.flush();
    expect(storage.files.has("a.log")).toBe(true);

    path = "b.log";
    await dynamic.log("msg-b");
    await dynamic.flush();
    expect(storage.files.has("b.log")).toBe(true);
  });

  test("rotates to .1 when existing file exceeds maxBytes", async () => {
    const bulky = "x".repeat(100);
    storage.files.set("test.log", `${bulky}\n`);
    const rotating = new LogManager(storage, () => "test.log", {
      maxLines: 100,
      flushSize: 1,
      maxBytes: 50,
      consoleOutput: false,
    });
    await rotating.log("after-rotate");
    expect(storage.files.get("test.log.1")).toContain(bulky);
    expect(storage.files.get("test.log")).toContain("after-rotate");
    expect(storage.files.get("test.log")).not.toContain(bulky);
  });
});
