import { dropboxContentHashBrowser } from "../hash.browser";
import type { FileSystem, RemoteStorage, SyncStateStore } from "../adapters/interfaces";
import type { ConflictContext, ConflictResolver, ConflictStrategy, DownloadResult, SyncPlanItem } from "../types";

/** skip된 conflict를 구분하기 위한 내부 에러 */
export class ConflictSkippedError extends Error {
  constructor() {
    super("conflict skipped");
    this.name = "ConflictSkippedError";
  }
}

/** conflict handler에 필요한 의존성 */
export interface ConflictHandlerDeps {
  fs: FileSystem;
  remote: RemoteStorage;
  store: SyncStateStore;
  conflictStrategy?: ConflictStrategy;
  conflictResolver?: ConflictResolver;
}

// ── 공유 유틸리티 ──

/** 다운로드 후 hash 검증 */
export async function downloadAndVerify(
  remote: RemoteStorage,
  localPath: string,
): Promise<DownloadResult & { verifiedHash: string }> {
  const result = await remote.download(localPath);
  const hash = await dropboxContentHashBrowser(result.data);
  if (result.metadata.hash && hash !== result.metadata.hash) {
    throw new Error(`Hash mismatch after download: expected ${result.metadata.hash}, got ${hash}`);
  }
  return { ...result, verifiedHash: hash };
}

/** sync state 갱신 */
export async function updateSyncState(
  store: SyncStateStore,
  pathLower: string,
  localPath: string,
  localHash: string,
  remoteHash: string,
  rev: string,
): Promise<void> {
  await store.setEntry({
    pathLower,
    localPath,
    baseLocalHash: localHash,
    baseRemoteHash: remoteHash,
    rev,
    lastSynced: Date.now(),
  });
}

/** 로컬 파일 읽기 + content hash 계산 */
async function readLocalWithHash(
  fs: FileSystem,
  path: string,
): Promise<{ data: Uint8Array; hash: string }> {
  const data = await fs.read(path);
  const hash = await dropboxContentHashBrowser(data);
  return { data, hash };
}

// ── Conflict Handlers ──

/** Outcome from a conflict handler (sibling path when keep_both wrote one). */
export interface ConflictHandlerResult {
  conflictSiblingPath?: string;
}

/** keep_both: 원격을 .conflict 파일로 보존, 로컬을 원격에 업로드 */
export async function handleConflictKeepBoth(
  item: SyncPlanItem,
  deps: ConflictHandlerDeps,
): Promise<ConflictHandlerResult> {
  const { fs, remote, store } = deps;
  const { pathLower, localPath } = item;

  const result = await downloadAndVerify(remote, localPath);
  const conflictPath = makeConflictPath(localPath);
  await fs.write(conflictPath, result.data, result.metadata.serverModified);

  const { data: localData, hash: localHash } = await readLocalWithHash(fs, localPath);
  const entry = await remote.upload(localPath, localData);

  await updateSyncState(store, pathLower, localPath, localHash, entry.hash ?? localHash, entry.rev);
  return { conflictSiblingPath: conflictPath };
}

/** newest: mtime 비교하여 더 최신 버전으로 통일. 동률 시 keep_both fallback */
export async function handleConflictNewest(
  item: SyncPlanItem,
  deps: ConflictHandlerDeps,
): Promise<ConflictHandlerResult> {
  const { fs, remote, store } = deps;
  const { pathLower, localPath } = item;

  const localStat = await fs.stat(localPath);
  const result = await downloadAndVerify(remote, localPath);

  const localMtime = localStat.mtime;
  const remoteMtime = result.metadata.serverModified;

  if (localMtime === remoteMtime) {
    return handleConflictKeepBoth(item, deps);
  }

  if (localMtime > remoteMtime) {
    const { data: localData, hash: localHash } = await readLocalWithHash(fs, localPath);
    const entry = await remote.upload(localPath, localData);
    await updateSyncState(store, pathLower, localPath, localHash, entry.hash ?? localHash, entry.rev);
  } else {
    await fs.write(localPath, result.data, result.metadata.serverModified);
    await updateSyncState(store, pathLower, localPath, result.verifiedHash, result.verifiedHash, result.metadata.rev);
  }
  return {};
}

/** manual: conflictResolver 콜백으로 사용자에게 위임. 없으면 keep_both fallback */
export async function handleConflictManual(
  item: SyncPlanItem,
  deps: ConflictHandlerDeps,
): Promise<ConflictHandlerResult> {
  const { fs, remote, store } = deps;
  const { pathLower, localPath } = item;

  if (!deps.conflictResolver) {
    return handleConflictKeepBoth(item, deps);
  }

  const { data: localData, hash: localHash } = await readLocalWithHash(fs, localPath);
  const result = await downloadAndVerify(remote, localPath);

  const context: ConflictContext = {
    localSize: localData.length,
    remoteSize: result.data.length,
    remoteMtime: result.metadata.serverModified,
  };

  const isText = /\.(md|txt|json|css|js|ts|html|xml|yaml|yml|csv|ini|cfg|log|toml)$/i.test(localPath);
  if (isText) {
    const decoder = new TextDecoder();
    context.localContent = decoder.decode(localData);
    context.remoteContent = decoder.decode(result.data);
  } else {
    context.localData = localData;
    context.remoteData = result.data;
  }

  const choice = await deps.conflictResolver(localPath, context);

  if (choice === "skip" || !choice) {
    throw new ConflictSkippedError();
  }

  if (choice === "local") {
    const entry = await remote.upload(localPath, localData);
    await updateSyncState(store, pathLower, localPath, localHash, entry.hash ?? localHash, entry.rev);
  } else if (choice === "remote") {
    await fs.write(localPath, result.data, result.metadata.serverModified);
    await updateSyncState(store, pathLower, localPath, result.verifiedHash, result.verifiedHash, result.metadata.rev);
  } else {
    const merged = choice.content;
    await fs.write(localPath, merged);
    const mergedHash = await dropboxContentHashBrowser(merged);
    const entry = await remote.upload(localPath, merged);
    await updateSyncState(store, pathLower, localPath, mergedHash, entry.hash ?? mergedHash, entry.rev);
  }
  return {};
}

/** 전략 → 핸들러 디스패치 맵 */
type ConflictHandler = (
  item: SyncPlanItem,
  deps: ConflictHandlerDeps,
) => Promise<ConflictHandlerResult>;

const CONFLICT_HANDLERS: Record<ConflictStrategy, ConflictHandler> = {
  keep_both: handleConflictKeepBoth,
  newest: handleConflictNewest,
  manual: handleConflictManual,
};

/** strategy에 따라 적절한 conflict handler를 호출 */
export function dispatchConflict(
  item: SyncPlanItem,
  deps: ConflictHandlerDeps,
): Promise<ConflictHandlerResult> {
  const strategy = deps.conflictStrategy ?? "keep_both";
  return CONFLICT_HANDLERS[strategy](item, deps);
}

/**
 * keep_both sibling path (timestamp avoids overwrite on repeated conflicts).
 * test.md → test.conflict-2026-03-05T1035.md — returned to UI via SyncPlanItem.conflictSiblingPath.
 */
export function makeConflictPath(path: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const lastDot = path.lastIndexOf(".");
  if (lastDot === -1) return `${path}.conflict-${ts}`;
  return `${path.slice(0, lastDot)}.conflict-${ts}${path.slice(lastDot)}`;
}

/**
 * Prefix used to discover keep_both siblings for `originalPath`
 * (e.g. notes/a.md → notes/a.conflict-).
 */
export function conflictSiblingStemPrefix(originalPath: string): string {
  const lastDot = originalPath.lastIndexOf(".");
  const lastSlash = originalPath.lastIndexOf("/");
  const hasExt = lastDot > lastSlash;
  return hasExt
    ? `${originalPath.slice(0, lastDot)}.conflict-`
    : `${originalPath}.conflict-`;
}

/** True when candidate is a .conflict-TIMESTAMP sibling of originalPath. */
export function isConflictSiblingOf(candidate: string, originalPath: string): boolean {
  const prefix = conflictSiblingStemPrefix(originalPath);
  if (!candidate.toLowerCase().startsWith(prefix.toLowerCase())) return false;
  const lastDot = originalPath.lastIndexOf(".");
  const lastSlash = originalPath.lastIndexOf("/");
  const hasExt = lastDot > lastSlash;
  const ext = hasExt ? originalPath.slice(lastDot) : "";
  if (ext) {
    if (!candidate.toLowerCase().endsWith(ext.toLowerCase())) return false;
    const mid = candidate.slice(prefix.length, candidate.length - ext.length);
    return /^\d{4}-\d{2}-\d{2}t\d{4}$/i.test(mid);
  }
  const mid = candidate.slice(prefix.length);
  return /^\d{4}-\d{2}-\d{2}t\d{4}$/i.test(mid);
}

/** Newest keep_both sibling for originalPath among vault paths (lexicographic timestamp). */
export function findNewestConflictSibling(
  vaultPaths: string[],
  originalPath: string,
): string | null {
  let best: string | null = null;
  for (const path of vaultPaths) {
    if (!isConflictSiblingOf(path, originalPath)) continue;
    if (!best || path.localeCompare(best) > 0) best = path;
  }
  return best;
}
