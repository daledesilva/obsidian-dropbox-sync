import type { PathIssue } from "./sync/path-validator";

/** Folder path discovered on local disk or remote listing (G8). */
export interface FolderInfo {
  path: string;
  pathLower: string;
}

/** 로컬 파일 정보 (vault에서 수집) */
export interface FileInfo {
  /** vault 내 경로 */
  path: string;
  /** Dropbox path_lower 형식 (비교 키) */
  pathLower: string;
  /** content_hash */
  hash: string;
  /** 수정 시각 (Unix ms) */
  mtime: number;
  /** 파일 크기 (bytes) */
  size: number;
}

/** 원격 파일 엔트리 (Dropbox에서 수집) */
export interface RemoteEntry {
  /** Dropbox path_lower */
  pathLower: string;
  /** Dropbox path_display */
  pathDisplay: string;
  /** content_hash (파일일 때만) */
  hash: string | null;
  /** 서버 수정 시각 (Unix ms) */
  serverModified: number;
  /** Editor modification time from Dropbox client_modified when present (Unix ms). */
  clientModified?: number;
  /** Dropbox rev */
  rev: string;
  /** 파일 크기 (bytes) */
  size: number;
  /** 삭제된 엔트리인지 */
  deleted: boolean;
  /** Dropbox folder entry (no content_hash). */
  isFolder?: boolean;
}

/** 동기화 상태 엔트리 (state store에 저장) */
export interface SyncEntry {
  /** Dropbox path_lower (정규화된 키) */
  pathLower: string;
  /** vault 내 경로 (표시용) */
  localPath: string;
  /** Last successfully synced Dropbox path_display (three-way casing, G6). */
  basePathDisplay?: string | null;
  /** 마지막 동기화 시점의 로컬 content_hash */
  baseLocalHash: string | null;
  /** 마지막 동기화 시점의 원격 content_hash */
  baseRemoteHash: string | null;
  /** Dropbox rev */
  rev: string | null;
  /** 마지막 동기화 시각 */
  lastSynced: number;
  /** `folder` rows track empty-folder presence with null hashes (G8). */
  entryKind?: "file" | "folder";
}

/** 동기화 액션 */
export type SyncAction =
  | { type: "upload"; reason: string }
  | { type: "download"; reason: string }
  | { type: "deleteLocal"; reason: string }
  | { type: "deleteRemote"; reason: string }
  | { type: "conflict"; localHash: string; remoteHash: string }
  | { type: "noop"; reason: string }
  /** G4: identical bytes — refresh base without transfer. */
  | {
      type: "recordBase";
      reason: string;
      localHash: string;
      remoteHash: string;
      rev: string;
      pathDisplay: string;
    }
  /** R10: remote path stays deleted; local bytes become a conflict copy on Dropbox. */
  | { type: "preserveAsConflictCopy"; reason: string }
  /** G6/G7: adopt remote display path locally (server-side move already done or pending elsewhere). */
  | { type: "moveLocal"; fromPath: string; toPath: string; reason: string }
  /** G6/G7: push a path change to Dropbox via server-side move. */
  | { type: "moveRemote"; fromPath: string; toPath: string; reason: string }
  /** G8: create an empty folder on the other side. */
  | { type: "createLocalFolder"; reason: string }
  | { type: "createRemoteFolder"; reason: string }
  /** G8: remove an empty folder on the other side. */
  | { type: "deleteLocalFolder"; reason: string }
  | { type: "deleteRemoteFolder"; reason: string }
  /** G7/G8: folder rename via server-side move + local rename. */
  | { type: "moveLocalFolder"; fromPath: string; toPath: string; reason: string }
  | { type: "moveRemoteFolder"; fromPath: string; toPath: string; reason: string }
  /** G14: file and folder share path_lower — report, never pick a destructive winner. */
  | {
      type: "pathCollision";
      localKind: "file" | "folder";
      remoteKind: "file" | "folder";
      reason: string;
    };

/** 동기화 계획 항목 */
export interface SyncPlanItem {
  pathLower: string;
  localPath: string;
  action: SyncAction;
  /**
   * Path of the keep_both sibling written for this item (Dropbox or legacy name).
   * Per-file status UI uses it for Compare without re-deriving the conflict filename.
   */
  conflictSiblingPath?: string;
}

/** 동기화 계획 */
export interface SyncPlan {
  items: SyncPlanItem[];
  stats: {
    upload: number;
    download: number;
    deleteLocal: number;
    deleteRemote: number;
    conflict: number;
    noop: number;
    recordBase: number;
    preserveAsConflictCopy: number;
    moveLocal: number;
    moveRemote: number;
    createLocalFolder: number;
    createRemoteFolder: number;
    deleteLocalFolder: number;
    deleteRemoteFolder: number;
    moveLocalFolder: number;
    moveRemoteFolder: number;
    pathCollision: number;
  };
}

/** Zeroed plan stats for tests and guard helpers. */
export function emptySyncPlanStats(): SyncPlan["stats"] {
  return {
    upload: 0,
    download: 0,
    deleteLocal: 0,
    deleteRemote: 0,
    conflict: 0,
    noop: 0,
    recordBase: 0,
    preserveAsConflictCopy: 0,
    moveLocal: 0,
    moveRemote: 0,
    createLocalFolder: 0,
    createRemoteFolder: 0,
    deleteLocalFolder: 0,
    deleteRemoteFolder: 0,
    moveLocalFolder: 0,
    moveRemoteFolder: 0,
    pathCollision: 0,
  };
}

/** Executor 실행 결과 */
export interface SyncResult {
  succeeded: SyncPlanItem[];
  failed: { item: SyncPlanItem; error: Error }[];
  /** 활성 파일 보호로 건너뛴 항목 */
  deferred: SyncPlanItem[];
}

/** 원격 변경 목록 응답 */
export interface ListChangesResult {
  entries: RemoteEntry[];
  cursor: string;
  hasMore: boolean;
}

/** 다운로드 결과 */
export interface DownloadResult {
  data: Uint8Array;
  metadata: RemoteEntry;
}

/** Dropbox 경로 검증 실패 에러 */
export class PathValidationError extends Error {
  constructor(
    public readonly path: string,
    public readonly reason: string,
  ) {
    super(`Invalid Dropbox path "${path}": ${reason}`);
    this.name = "PathValidationError";
  }
}

/** 로컬(기기) 경로 검증 실패 에러 */
export class LocalPathError extends Error {
  constructor(
    public readonly path: string,
    public readonly reason: string,
  ) {
    super(`Path not supported on this device "${path}": ${reason}`);
    this.name = "LocalPathError";
  }
}

/** 경로 가드에서 감지된 항목 */
export interface PathGuardIssue {
  item: SyncPlanItem;
  issues: PathIssue[];
  suggestedPath: string;
}

/** 경로 가드 결과 */
export interface PathGuardResult {
  passed: boolean;
  issues: PathGuardIssue[];
  filteredPlan: SyncPlan;
}

/** 경로 모달 해결 결과 */
export type PathIssueResolution =
  | { action: "skip" }
  | { action: "renamed"; renames: { from: string; to: string }[] };

/** Conflict 시 사용자에게 전달할 컨텍스트 */
export interface ConflictContext {
  localContent?: string;
  remoteContent?: string;
  localData?: Uint8Array;
  remoteData?: Uint8Array;
  localSize?: number;
  remoteSize?: number;
  remoteMtime?: number;
}

/** Dropbox rev 충돌 에러 */
export class RevConflictError extends Error {
  constructor(
    message: string,
    public readonly currentRev: string,
  ) {
    super(message);
    this.name = "RevConflictError";
  }
}

/** Conflict resolution UX only — R2 outcomes are fixed (keep_both semantics). */
export type ConflictStrategy = "keep_both" | "manual";

/** manual 전략에서 사용자 선택 결과 */
export type ConflictResolverResult =
  | "local"
  | "remote"
  | "skip"
  | { type: "merged"; content: Uint8Array }
  | null;

/** manual 전략에서 사용자 선택을 반환하는 콜백 */
export type ConflictResolver = (
  localPath: string,
  context?: ConflictContext,
) => Promise<ConflictResolverResult>;

/** 삭제 가드 결과 */
export interface DeleteGuardResult {
  /** 가드 통과 여부 */
  passed: boolean;
  /** 삭제 대상 항목 */
  deleteItems: SyncPlanItem[];
  /** 삭제 항목을 제외한 나머지 플랜 */
  filteredPlan: SyncPlan;
}
