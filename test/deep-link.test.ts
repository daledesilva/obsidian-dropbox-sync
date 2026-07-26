import { describe, test, expect, beforeEach } from "bun:test";
import { fetchFileFromRemote, type FetchFileDeps } from "@/deep-link";
import { MemoryFileSystem, MemoryRemoteStorage, MemoryStateStore } from "@/adapters/memory";
import { dropboxContentHash } from "@/hash";

describe("fetchFileFromRemote", () => {
  let fs: MemoryFileSystem;
  let remote: MemoryRemoteStorage;
  let store: MemoryStateStore;
  let deps: FetchFileDeps;

  const testContent = new TextEncoder().encode("hello world");

  beforeEach(async () => {
    fs = new MemoryFileSystem();
    remote = new MemoryRemoteStorage();
    store = new MemoryStateStore();
    deps = {
      remote,
      fs,
      store,
      computeHash: dropboxContentHash,
    };

    // 원격에 파일 준비
    await remote.upload("notes/test.md", testContent);
  });

  test("원격 파일을 다운로드하여 로컬에 저장", async () => {
    expect(fs.has("notes/test.md")).toBe(false);

    await fetchFileFromRemote("notes/test.md", deps);

    expect(fs.has("notes/test.md")).toBe(true);
    const data = fs.getData("notes/test.md");
    expect(data).toEqual(testContent);
  });

  test("sync state 업데이트 (재다운로드 방지)", async () => {
    await fetchFileFromRemote("notes/test.md", deps);

    const entry = await store.getEntry("notes/test.md");
    expect(entry).not.toBeNull();
    expect(entry!.localPath).toBe("notes/test.md");
    expect(entry!.baseLocalHash).not.toBeNull();
    expect(entry!.baseRemoteHash).not.toBeNull();
    expect(entry!.baseLocalHash).toBe(entry!.baseRemoteHash); // 같은 데이터
    expect(entry!.rev).not.toBeNull();
    expect(entry!.lastSynced).toBeGreaterThan(0);
  });

  test("다운로드 결과에 pathLower, rev 포함", async () => {
    const result = await fetchFileFromRemote("notes/test.md", deps);

    expect(result.pathLower).toBe("notes/test.md");
    expect(result.rev).toBeTruthy();
    expect(result.data).toEqual(testContent);
  });

  test("store 없이도 다운로드 + 쓰기 동작", async () => {
    const depsNoStore: FetchFileDeps = { ...deps, store: null };

    await fetchFileFromRemote("notes/test.md", depsNoStore);

    expect(fs.has("notes/test.md")).toBe(true);
    expect(store.getEntryCount()).toBe(0); // state 미업데이트
  });

  test("원격에 없는 파일 → 에러", async () => {
    await expect(
      fetchFileFromRemote("does-not-exist.md", deps),
    ).rejects.toThrow("File not found on remote");
  });

  test("대소문자 경로 정규화", async () => {
    // MemoryRemoteStorage는 pathLower로 조회
    await fetchFileFromRemote("Notes/Test.md", deps);

    expect(fs.has("Notes/Test.md")).toBe(true);
    const entry = await store.getEntry("notes/test.md");
    expect(entry).not.toBeNull();
    expect(entry!.localPath).toBe("Notes/Test.md");
  });

  test("큰 파일 다운로드 + hash 일치", async () => {
    // 5MB 파일 (멀티블록 해싱)
    const bigContent = new Uint8Array(5 * 1024 * 1024);
    bigContent.fill(42);
    await remote.upload("big-file.bin", bigContent);

    await fetchFileFromRemote("big-file.bin", deps);

    expect(fs.has("big-file.bin")).toBe(true);
    const entry = await store.getEntry("big-file.bin");
    expect(entry!.baseLocalHash).toBe(entry!.baseRemoteHash);
  });

  test("동일 파일 두 번 fetch → 최신 state 유지", async () => {
    await fetchFileFromRemote("notes/test.md", deps);
    const first = await store.getEntry("notes/test.md");

    // 원격 파일 업데이트
    const updatedContent = new TextEncoder().encode("updated content");
    await remote.upload("notes/test.md", updatedContent, first!.rev!);

    await fetchFileFromRemote("notes/test.md", deps);
    const second = await store.getEntry("notes/test.md");

    expect(second!.rev).not.toBe(first!.rev);
    expect(second!.lastSynced).toBeGreaterThanOrEqual(first!.lastSynced);

    const localData = fs.getData("notes/test.md");
    expect(localData).toEqual(updatedContent);
  });
});
