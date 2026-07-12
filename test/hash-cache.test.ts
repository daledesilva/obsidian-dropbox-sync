import { describe, test, expect, beforeEach } from "bun:test";
import { VaultAdapter } from "@/adapters/vault-adapter";

/**
 * VaultAdapter의 해시 캐시 테스트.
 * Obsidian Vault API를 최소한으로 mock하여 캐시 동작을 검증한다.
 */

interface MockFile {
  path: string;
  stat: { mtime: number; size: number };
  extension: string;
  data: ArrayBuffer;
}

function createMockVault(files: MockFile[]) {
  const fileMap = new Map<string, MockFile>();
  for (const f of files) fileMap.set(f.path, f);

  let readBinaryCount = 0;

  const vault = {
    getFiles: () => [...fileMap.values()],
    getAbstractFileByPath: (path: string) => fileMap.get(path) ?? null,
    readBinary: async (file: MockFile) => {
      readBinaryCount++;
      return file.data;
    },
    trash: async () => {},
    modifyBinary: async () => {},
    createBinary: async () => {},
    createFolder: async () => {},
    getReadBinaryCount: () => readBinaryCount,
    resetReadBinaryCount: () => { readBinaryCount = 0; },
    // 파일 추가/수정 헬퍼
    updateFile: (path: string, data: ArrayBuffer, mtime: number) => {
      const existing = fileMap.get(path);
      if (existing) {
        existing.data = data;
        existing.stat = { mtime, size: data.byteLength };
      } else {
        const file: MockFile = {
          path,
          stat: { mtime, size: data.byteLength },
          extension: path.split(".").pop() ?? "",
          data,
        };
        fileMap.set(path, file);
      }
    },
    removeFile: (path: string) => {
      fileMap.delete(path);
    },
  };

  return vault;
}

function textToBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

describe("VaultAdapter hash cache", () => {
  let vault: ReturnType<typeof createMockVault>;
  let adapter: VaultAdapter;

  beforeEach(() => {
    vault = createMockVault([
      { path: "a.md", stat: { mtime: 1000, size: 5 }, extension: "md", data: textToBuffer("hello") },
      { path: "b.md", stat: { mtime: 2000, size: 5 }, extension: "md", data: textToBuffer("world") },
    ]);
    adapter = new VaultAdapter(vault as never, [], {} as never);
  });

  test("첫 list(): 모든 파일 readBinary 호출", async () => {
    await adapter.list();
    expect(vault.getReadBinaryCount()).toBe(2);
  });

  test("두 번째 list(): 변경 없으면 readBinary 미호출 (캐시 히트)", async () => {
    await adapter.list();
    vault.resetReadBinaryCount();

    await adapter.list();
    expect(vault.getReadBinaryCount()).toBe(0);
  });

  test("mtime 변경 → readBinary 재호출", async () => {
    await adapter.list();
    vault.resetReadBinaryCount();

    // a.md의 mtime 변경
    vault.updateFile("a.md", textToBuffer("hello"), 1500);

    await adapter.list();
    // a.md만 재해싱, b.md는 캐시 히트
    expect(vault.getReadBinaryCount()).toBe(1);
  });

  test("size 변경 → readBinary 재호출", async () => {
    await adapter.list();
    vault.resetReadBinaryCount();

    // a.md의 내용과 size 변경 (mtime 동일하지만 size 다름)
    vault.updateFile("a.md", textToBuffer("hello world"), 1000);

    await adapter.list();
    expect(vault.getReadBinaryCount()).toBe(1);
  });

  test("새 파일 추가 → 새 파일만 readBinary", async () => {
    await adapter.list();
    vault.resetReadBinaryCount();

    vault.updateFile("c.md", textToBuffer("new file"), 3000);

    const files = await adapter.list();
    expect(files).toHaveLength(3);
    // 기존 2개 캐시 히트, 새 파일 1개만 해싱
    expect(vault.getReadBinaryCount()).toBe(1);
  });

  test("파일 삭제 → 이전 캐시 정리됨", async () => {
    await adapter.list();
    vault.removeFile("a.md");

    const files = await adapter.list();
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("b.md");
  });

  test("clearCache() → 모두 재해싱", async () => {
    await adapter.list();
    vault.resetReadBinaryCount();

    adapter.clearCache();
    await adapter.list();
    expect(vault.getReadBinaryCount()).toBe(2);
  });

  test("list() 결과에 올바른 hash, mtime, size 포함", async () => {
    const files = await adapter.list();
    expect(files).toHaveLength(2);
    for (const f of files) {
      expect(f.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(f.mtime).toBeGreaterThan(0);
      expect(f.size).toBeGreaterThan(0);
      expect(f.pathLower).toBe(f.path.toLowerCase());
    }
  });

  test("같은 내용 → 같은 hash", async () => {
    vault = createMockVault([
      { path: "x.md", stat: { mtime: 1000, size: 4 }, extension: "md", data: textToBuffer("same") },
      { path: "y.md", stat: { mtime: 2000, size: 4 }, extension: "md", data: textToBuffer("same") },
    ]);
    adapter = new VaultAdapter(vault as never, [], {} as never);

    const files = await adapter.list();
    expect(files[0].hash).toBe(files[1].hash);
  });

  // ── stat() ──

  test("stat(): mtime과 size 반환", async () => {
    const result = await adapter.stat("a.md");
    expect(result).toEqual({ mtime: 1000, size: 5 });
  });

  test("stat(): 존재하지 않는 파일 → 에러", async () => {
    await expect(adapter.stat("missing.md")).rejects.toThrow();
  });

  // ── exclude ──

  test("exclude 패턴 적용", async () => {
    vault = createMockVault([
      { path: "notes/a.md", stat: { mtime: 1000, size: 3 }, extension: "md", data: textToBuffer("aaa") },
      { path: ".trash/b.md", stat: { mtime: 2000, size: 3 }, extension: "md", data: textToBuffer("bbb") },
    ]);
    adapter = new VaultAdapter(vault as never, [".trash/"], {} as never);

    const files = await adapter.list();
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("notes/a.md");
  });
});
