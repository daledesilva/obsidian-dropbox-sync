import { describe, test, expect } from "bun:test";
import {
  classifyChange,
  createPlan,
  type LocalState,
  type RemoteState,
  type ClassifyOptions,
} from "@/sync/planner";
import type { FileInfo, RemoteEntry, SyncEntry } from "@/types";
import { emptySyncPlanStats } from "@/types";

// ── classifyChange 단위 테스트 ──

describe("classifyChange", () => {
  const base: SyncEntry = {
    pathLower: "test.md",
    localPath: "test.md",
    baseLocalHash: "hash_base",
    baseRemoteHash: "hash_base",
    rev: "rev_1",
    lastSynced: 1000,
  };

  // 1. 로컬에만 존재 (신규) → upload
  test("새 로컬 파일 (base 없음, remote 없음) → upload", () => {
    const local: LocalState = { hash: "hash_new", path: "new.md" };
    const action = classifyChange(local, null, null);
    expect(action.type).toBe("upload");
    if (action.type === "upload") expect(action.reason).toBe("new_local");
  });

  // 2. 원격에만 존재 (신규) → download
  test("새 원격 파일 (base 없음, local 없음) → download", () => {
    const remote: RemoteState = {
      hash: "hash_new",
      pathDisplay: "new.md",
      rev: "rev_1",
      deleted: false,
    };
    const action = classifyChange(null, remote, null);
    expect(action.type).toBe("download");
    if (action.type === "download") expect(action.reason).toBe("new_remote");
  });

  // 3. 양쪽 동일 hash → noop
  test("양쪽 동일 content → noop", () => {
    const local: LocalState = { hash: "same", path: "test.md" };
    const remote: RemoteState = {
      hash: "same",
      pathDisplay: "test.md",
      rev: "rev_1",
      deleted: false,
    };
    const action = classifyChange(local, remote, base);
    expect(action.type).toBe("noop");
  });

  // 4. 로컬만 변경 → upload
  test("로컬만 변경 → upload", () => {
    const local: LocalState = { hash: "hash_modified", path: "test.md" };
    const remote: RemoteState = {
      hash: "hash_base",
      pathDisplay: "test.md",
      rev: "rev_1",
      deleted: false,
    };
    const action = classifyChange(local, remote, base);
    expect(action.type).toBe("upload");
  });

  // 5. 원격만 변경 → download
  test("원격만 변경 → download", () => {
    const local: LocalState = { hash: "hash_base", path: "test.md" };
    const remote: RemoteState = {
      hash: "hash_modified",
      pathDisplay: "test.md",
      rev: "rev_2",
      deleted: false,
    };
    const action = classifyChange(local, remote, base);
    expect(action.type).toBe("download");
  });

  // 6. 로컬 삭제 (base 있고 remote 미변경) + 삭제 의도 있음 → deleteRemote
  test("로컬 삭제 + 원격 미변경 + 삭제 의도 → deleteRemote", () => {
    const remote: RemoteState = {
      hash: "hash_base",
      pathDisplay: "test.md",
      rev: "rev_1",
      deleted: false,
    };
    const action = classifyChange(null, remote, base, { localDeleteIntended: true });
    expect(action.type).toBe("deleteRemote");
    if (action.type === "deleteRemote")
      expect(action.reason).toBe("deleted_on_local");
  });

  // 6b. 로컬 부재 + 원격 미변경 + 삭제 의도 없음 → download (복구)
  test("로컬 부재 + 원격 미변경 + 삭제 의도 없음 → download (복구)", () => {
    const remote: RemoteState = {
      hash: "hash_base",
      pathDisplay: "test.md",
      rev: "rev_1",
      deleted: false,
    };
    const action = classifyChange(null, remote, base);
    expect(action.type).toBe("download");
    if (action.type === "download")
      expect(action.reason).toBe("missing_local_restored");
  });

  // 6c. 로컬 부재 + 원격 미변경 + localDeleteIntended=false → download (복구)
  test("로컬 부재 + 원격 미변경 + localDeleteIntended=false → download (복구)", () => {
    const remote: RemoteState = {
      hash: "hash_base",
      pathDisplay: "test.md",
      rev: "rev_1",
      deleted: false,
    };
    const action = classifyChange(null, remote, base, { localDeleteIntended: false });
    expect(action.type).toBe("download");
    if (action.type === "download")
      expect(action.reason).toBe("missing_local_restored");
  });

  // 7. 원격 삭제 (base 있고 local 미변경) → deleteLocal
  test("원격 삭제 + 로컬 미변경 → deleteLocal", () => {
    const local: LocalState = { hash: "hash_base", path: "test.md" };
    const action = classifyChange(local, null, base);
    expect(action.type).toBe("deleteLocal");
    if (action.type === "deleteLocal")
      expect(action.reason).toBe("deleted_on_remote");
  });

  // 8. 양쪽 변경 + hash 다름 → conflict
  test("양쪽 변경 → conflict", () => {
    const local: LocalState = { hash: "hash_local_new", path: "test.md" };
    const remote: RemoteState = {
      hash: "hash_remote_new",
      pathDisplay: "test.md",
      rev: "rev_2",
      deleted: false,
    };
    const action = classifyChange(local, remote, base);
    expect(action.type).toBe("conflict");
    if (action.type === "conflict") {
      expect(action.localHash).toBe("hash_local_new");
      expect(action.remoteHash).toBe("hash_remote_new");
    }
  });

  // 9. 양쪽 모두 없음 → noop
  test("양쪽 모두 없음 → noop", () => {
    const action = classifyChange(null, null, null);
    expect(action.type).toBe("noop");
    if (action.type === "noop") expect(action.reason).toBe("both_absent");
  });

  // 10. 로컬 삭제 + 원격 변경 → download (변경 우선)
  test("로컬 삭제 + 원격 변경 → download (변경 우선)", () => {
    const remote: RemoteState = {
      hash: "hash_modified",
      pathDisplay: "test.md",
      rev: "rev_2",
      deleted: false,
    };
    const action = classifyChange(null, remote, base);
    expect(action.type).toBe("download");
    if (action.type === "download")
      expect(action.reason).toBe("remote_modified_local_deleted");
  });

  // 11. 원격 삭제 + 로컬 변경 → upload (변경 우선)
  test("원격 삭제 + 로컬 변경 → upload (변경 우선)", () => {
    const local: LocalState = { hash: "hash_modified", path: "test.md" };
    const action = classifyChange(local, null, base);
    expect(action.type).toBe("upload");
    if (action.type === "upload")
      expect(action.reason).toBe("local_modified_remote_deleted");
  });

  // 12. 이전 기록 없음 + 양쪽 존재 + hash 다름 → conflict
  test("base 없음 + 양쪽 존재 + hash 다름 → conflict", () => {
    const local: LocalState = { hash: "hash_a", path: "test.md" };
    const remote: RemoteState = {
      hash: "hash_b",
      pathDisplay: "test.md",
      rev: "rev_1",
      deleted: false,
    };
    const action = classifyChange(local, remote, null);
    expect(action.type).toBe("conflict");
  });

  // 13. base 없음 + 양쪽 존재 + hash 같음 → noop
  test("base 없음 + 양쪽 동일 hash → noop", () => {
    const local: LocalState = { hash: "same", path: "test.md" };
    const remote: RemoteState = {
      hash: "same",
      pathDisplay: "test.md",
      rev: "rev_1",
      deleted: false,
    };
    const action = classifyChange(local, remote, null);
    expect(action.type).toBe("noop");
  });

  // 14. 원격이 deleted 플래그 → 원격 없는 것과 동일
  test("remote.deleted=true → 원격 없음으로 처리", () => {
    const local: LocalState = { hash: "hash_base", path: "test.md" };
    const remote: RemoteState = {
      hash: "hash_base",
      pathDisplay: "test.md",
      rev: "rev_1",
      deleted: true,
    };
    const action = classifyChange(local, remote, base);
    expect(action.type).toBe("deleteLocal");
  });

  // 15. base만 존재 (양쪽 삭제) → noop
  test("양쪽 삭제 + base 있음 → noop", () => {
    const action = classifyChange(null, null, base);
    expect(action.type).toBe("noop");
  });
});

// ── createPlan 통합 테스트 ──

describe("createPlan", () => {
  const mkLocal = (path: string, hash: string): FileInfo => ({
    path,
    pathLower: path.toLowerCase(),
    hash,
    mtime: Date.now(),
    size: 100,
  });

  const mkRemote = (
    path: string,
    hash: string,
    rev = "rev_1",
    deleted = false,
  ): RemoteEntry => ({
    pathLower: path.toLowerCase(),
    pathDisplay: path,
    hash,
    serverModified: Date.now(),
    rev,
    size: 100,
    deleted,
  });

  const mkBase = (path: string, hash: string, rev = "rev_1"): SyncEntry => ({
    pathLower: path.toLowerCase(),
    localPath: path,
    baseLocalHash: hash,
    baseRemoteHash: hash,
    rev,
    lastSynced: Date.now(),
  });

  test("여러 파일 통합 플랜", () => {
    const plan = createPlan(
      [mkLocal("a.md", "hash_a"), mkLocal("b.md", "hash_b_new")],
      [mkRemote("a.md", "hash_a"), mkRemote("c.md", "hash_c")],
      [mkBase("a.md", "hash_a"), mkBase("b.md", "hash_b")],
    );

    // a.md: 양쪽 동일 → recordBase (G4)
    // b.md: 로컬만 변경 + 원격 삭제(base에는 있지만 remote에 없음) → upload (변경 우선)
    // c.md: 새 원격 파일 → download
    expect(plan.items).toHaveLength(3);
    expect(plan.stats.noop).toBe(1);
    expect(plan.stats.recordBase).toBe(1);

    const aAction = plan.items.find((i) => i.pathLower === "a.md");
    expect(aAction?.action.type).toBe("recordBase");

    const bAction = plan.items.find((i) => i.pathLower === "b.md");
    expect(bAction?.action.type).toBe("upload");

    const cAction = plan.items.find((i) => i.pathLower === "c.md");
    expect(cAction?.action.type).toBe("download");
  });

  test("same_content → recordBase in plan", () => {
    const plan = createPlan(
      [mkLocal("a.md", "same")],
      [mkRemote("a.md", "same")],
      [],
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].action.type).toBe("recordBase");
    expect(plan.stats.recordBase).toBe(1);
    expect(plan.stats.noop).toBe(1);
  });

  test("빈 입력 → 빈 플랜", () => {
    const plan = createPlan([], [], []);
    expect(plan.items).toHaveLength(0);
    expect(plan.stats).toEqual(emptySyncPlanStats());
  });

  test("대소문자 정규화: pathLower 기준 매칭", () => {
    const plan = createPlan(
      [mkLocal("Notes/README.md", "same")],
      [mkRemote("notes/readme.md", "same")],
      [],
    );
    // 같은 파일로 매칭 → recordBase (G4)
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].action.type).toBe("recordBase");
    expect(plan.stats.noop).toBe(1);
  });

  test("localPath 우선순위: 로컬 → 원격 → base", () => {
    // 원격에만 존재하는 파일
    const plan = createPlan([], [mkRemote("Notes/New.md", "hash")], []);
    expect(plan.items[0].localPath).toBe("Notes/New.md");
  });

  test("localDeletedPaths로 삭제 의도 전달", () => {
    const plan = createPlan(
      [], // 로컬에 a.md 없음
      [mkRemote("a.md", "hash_a")], // 원격에 있음
      [mkBase("a.md", "hash_a")], // base에 있음 (이전 동기화됨)
      { localDeletedPaths: new Set(["a.md"]) },
    );
    // 삭제 의도 있음 → deleteRemote
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].action.type).toBe("deleteRemote");
  });

  test("localDeletedPaths 없으면 부재 파일 download로 복구", () => {
    const plan = createPlan(
      [], // 로컬에 a.md 없음
      [mkRemote("a.md", "hash_a")], // 원격에 있음
      [mkBase("a.md", "hash_a")], // base에 있음
    );
    // 삭제 의도 없음 → download (복구)
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].action.type).toBe("download");
  });

  test("stats 정확성", () => {
    const plan = createPlan(
      [
        mkLocal("upload.md", "new_hash"),
        mkLocal("conflict.md", "local_hash"),
      ],
      [
        mkRemote("download.md", "hash_d"),
        mkRemote("conflict.md", "remote_hash"),
      ],
      [mkBase("upload.md", "old_hash"), mkBase("conflict.md", "base_hash")],
    );

    expect(plan.stats.upload).toBe(1);
    expect(plan.stats.download).toBe(1);
    expect(plan.stats.conflict).toBe(1);
  });
});
