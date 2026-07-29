import { dropboxContentHashBrowser } from "../hash.browser";
import type { FileSystem, RemoteStorage, SyncStateStore } from "../adapters/interfaces";
import type { ConflictContext, ConflictResolver, ConflictStrategy, DownloadResult, RemoteEntry, SyncPlanItem } from "../types";
import { logTemp } from "../debug/temp-log";
import { getDeviceId } from "../device-settings/device-settings";
import {
  logRule,
  shortHash,
  SyncLogCategories,
  SyncRules,
  type SyncMonitorLog,
} from "../debug/sync-monitor";

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
  log?: SyncMonitorLog;
  /** Vault paths for reusing an existing keep_both sibling (G18). */
  listVaultPaths?: () => string[];
}

// ── Conflict copy detection (association only — never used to exclude scans) ──

/** Legacy keep_both sibling: `.conflict-YYYY-MM-DDTHHMM` before extension. */
const LEGACY_CONFLICT_RE = /\.conflict-\d{4}-\d{2}-\d{2}t\d{4}/i;

/** Dropbox format: `note (Device's conflicted copy YYYY-MM-DD).md` with optional same-day counter. */
const DROPBOX_CONFLICT_RE = / \([^)]*'s conflicted copy \d{4}-\d{2}-\d{2}(?: \d+)?\)(?:\.[^/]+)?$/i;

export function isLegacyConflictFile(path: string): boolean {
  return LEGACY_CONFLICT_RE.test(path);
}

export function isDropboxConflictFile(path: string): boolean {
  return DROPBOX_CONFLICT_RE.test(path);
}

/** Detect conflict copies in either naming format (for association / UI — not scan exclusion). */
export function isConflictFile(path: string): boolean {
  return isLegacyConflictFile(path) || isDropboxConflictFile(path);
}

/** Map a conflict copy path to its canonical vault path, or null when not a conflict copy. */
export function conflictPathToCanonicalPath(conflictPath: string): string | null {
  if (isLegacyConflictFile(conflictPath)) {
    return conflictPath.replace(/\.conflict-\d{4}-\d{2}-\d{2}t\d{4}/i, "");
  }
  const match = conflictPath.match(
    /^(.+?) \([^)]+'s conflicted copy \d{4}-\d{2}-\d{2}(?: \d+)?\)(\.[^./]+)?$/i,
  );
  if (!match) return null;
  return `${match[1]}${match[2] ?? ""}`;
}

/** Human-readable device label embedded in Dropbox conflict copy names (R4). */
export function getConflictDeviceLabel(): string {
  return `Device ${getDeviceId()}`;
}

function splitCanonicalPath(path: string): { dir: string; stem: string; ext: string } {
  const lastSlash = path.lastIndexOf("/");
  const dir = lastSlash >= 0 ? path.slice(0, lastSlash) : "";
  const baseName = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const lastDot = baseName.lastIndexOf(".");
  const hasExt = lastDot > 0;
  const stem = hasExt ? baseName.slice(0, lastDot) : baseName;
  const ext = hasExt ? baseName.slice(lastDot) : "";
  return { dir, stem, ext };
}

function formatConflictDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function joinPath(dir: string, fileName: string): string {
  return dir ? `${dir}/${fileName}` : fileName;
}

/** Parse same-day counter from a Dropbox conflict copy (0 when absent). */
function dropboxConflictCounter(path: string, dateStr: string): number {
  const match = path.match(
    new RegExp(`'s conflicted copy ${dateStr.replace(/[-]/g, "\\-")}(?: (\\d+))?\\)`, "i"),
  );
  if (!match) return -1;
  return match[1] ? parseInt(match[1], 10) : 0;
}

function legacyConflictTimestamp(path: string): string | null {
  const match = path.match(/\.conflict-(\d{4}-\d{2}-\d{2}t\d{4})/i);
  return match ? match[1].toLowerCase() : null;
}

/** Relative ordering for conflict siblings (newer → larger). */
export function compareConflictSiblingNewness(a: string, b: string): number {
  const aLegacy = legacyConflictTimestamp(a);
  const bLegacy = legacyConflictTimestamp(b);
  if (aLegacy && bLegacy) return aLegacy.localeCompare(bLegacy);
  if (aLegacy) return -1;
  if (bLegacy) return 1;

  const aDate = a.match(/'s conflicted copy (\d{4}-\d{2}-\d{2})/i)?.[1];
  const bDate = b.match(/'s conflicted copy (\d{4}-\d{2}-\d{2})/i)?.[1];
  if (aDate && bDate) {
    const dateCmp = aDate.localeCompare(bDate);
    if (dateCmp !== 0) return dateCmp;
    const aCounter = dropboxConflictCounter(a, aDate);
    const bCounter = dropboxConflictCounter(b, bDate);
    return aCounter - bCounter;
  }
  return a.localeCompare(b);
}

/**
 * Mint a Dropbox-format conflict copy path (R4).
 * Same-day repeats from this device append ` 2`, ` 3`, … after the date.
 */
export function makeConflictPath(
  canonicalPath: string,
  existingPaths: string[] = [],
  options?: { deviceLabel?: string; now?: Date },
): string {
  const deviceLabel = options?.deviceLabel ?? getConflictDeviceLabel();
  const dateStr = formatConflictDate(options?.now ?? new Date());
  const { dir, stem, ext } = splitCanonicalPath(canonicalPath);

  let sameDayCount = 0;
  for (const existing of existingPaths) {
    if (!isConflictSiblingOf(existing, canonicalPath)) continue;
    if (!existing.includes(`${deviceLabel}'s conflicted copy ${dateStr}`)) continue;
    sameDayCount++;
  }

  const counterSuffix = sameDayCount === 0 ? "" : ` ${sameDayCount + 1}`;
  const fileName = `${stem} (${deviceLabel}'s conflicted copy ${dateStr}${counterSuffix})${ext}`;
  return joinPath(dir, fileName);
}

/**
 * Prefix used to discover legacy keep_both siblings for `originalPath`
 * (e.g. notes/a.md → notes/a.conflict-).
 */
export function conflictSiblingStemPrefix(originalPath: string): string {
  const { dir, stem } = splitCanonicalPath(originalPath);
  return joinPath(dir, `${stem}.conflict-`);
}

/** True when candidate is a conflict sibling of originalPath (legacy or Dropbox format). */
export function isConflictSiblingOf(candidate: string, originalPath: string): boolean {
  const canonical = conflictPathToCanonicalPath(candidate);
  if (canonical !== null) {
    return canonical === originalPath;
  }
  return false;
}

/** True when candidate is a conflict sibling attributed to the given device label. */
export function isConflictSiblingFromDevice(
  candidate: string,
  originalPath: string,
  deviceLabel: string,
): boolean {
  if (!isConflictSiblingOf(candidate, originalPath)) return false;
  if (isDropboxConflictFile(candidate)) {
    return candidate.includes(`${deviceLabel}'s conflicted copy`);
  }
  // Legacy copies carry no device identity — eligible for reuse on this device during transition.
  return isLegacyConflictFile(candidate);
}

/** Newest keep_both sibling for originalPath among vault paths. */
export function findNewestConflictSibling(
  vaultPaths: string[],
  originalPath: string,
): string | null {
  let best: string | null = null;
  for (const path of vaultPaths) {
    if (!isConflictSiblingOf(path, originalPath)) continue;
    if (!best || compareConflictSiblingNewness(path, best) > 0) best = path;
  }
  return best;
}

/**
 * R13 / G23: reuse an existing unresolved conflict copy from this device when present
 * instead of minting another sibling.
 */
export function findExistingDeviceConflictCopy(
  vaultPaths: string[],
  originalPath: string,
  deviceLabel?: string,
): string | null {
  const label = deviceLabel ?? getConflictDeviceLabel();
  let best: string | null = null;
  for (const path of vaultPaths) {
    if (!isConflictSiblingFromDevice(path, originalPath, label)) continue;
    if (!best || compareConflictSiblingNewness(path, best) > 0) best = path;
  }
  return best;
}

// ── 공유 유틸리티 ──

function resolveWriteMtime(metadata: RemoteEntry): number | undefined {
  const mtime = metadata.clientModified ?? metadata.serverModified;
  return mtime > 0 ? mtime : undefined;
}

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
  basePathDisplay?: string | null,
): Promise<void> {
  await store.setEntry({
    pathLower,
    localPath,
    basePathDisplay: basePathDisplay ?? localPath,
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

/** Pick or mint a conflict copy path for canonicalPath (R13 / G23). */
export async function resolveConflictCopyPath(
  fs: FileSystem,
  canonicalPath: string,
  log: SyncMonitorLog | undefined,
): Promise<string> {
  const localFiles = await fs.list();
  const existingPaths = localFiles.map((f) => f.path);
  const deviceLabel = getConflictDeviceLabel();

  const reused = findExistingDeviceConflictCopy(existingPaths, canonicalPath, deviceLabel);
  if (reused) {
    logTemp(log, "P2", "reusing existing device conflict copy", {
      canonicalPath,
      conflictCopyPath: reused,
      deviceLabel,
    }, { location: "conflict-handlers.resolveConflictCopyPath" });
    return reused;
  }

  const minted = makeConflictPath(canonicalPath, existingPaths, { deviceLabel });
  logTemp(log, "P2", "minted Dropbox-format conflict copy path", {
    canonicalPath,
    conflictCopyPath: minted,
    deviceLabel,
  }, { location: "conflict-handlers.resolveConflictCopyPath" });
  return minted;
}

// ── Conflict Handlers ──

/** Outcome from a conflict handler (sibling path when keep_both wrote one). */
export interface ConflictHandlerResult {
  conflictSiblingPath?: string;
}

/**
 * R2 inverted keep_both (G2): Dropbox bytes keep the canonical path; local bytes
 * become a conflict sibling locally and on Dropbox so both sides propagate (G1).
 */
export async function resolveConflictKeepRemoteCanonical(
  item: SyncPlanItem,
  deps: ConflictHandlerDeps,
  localData: Uint8Array,
  localHash: string,
  remoteResult: DownloadResult & { verifiedHash: string },
): Promise<ConflictHandlerResult> {
  const { fs, remote, store, log } = deps;
  const { pathLower, localPath } = item;

  await fs.write(localPath, remoteResult.data, resolveWriteMtime(remoteResult.metadata));

  const conflictPath = await resolveConflictCopyPath(fs, localPath, log);
  await fs.write(conflictPath, localData);
  const { mtime: conflictMtime } = await fs.stat(conflictPath);

  const conflictPathLower = conflictPath.toLowerCase();
  const existingConflictEntry = await store.getEntry(conflictPathLower);
  const conflictEntry = existingConflictEntry?.rev
    ? await remote.upload(conflictPath, localData, existingConflictEntry.rev, conflictMtime)
    : await remote.upload(conflictPath, localData, undefined, conflictMtime);

  logTemp(log, "P2", "inverted keep_both — remote canonical, conflict copy uploaded", {
    path: localPath,
    conflictCopyPath: conflictPath,
    reusedCopy: !!existingConflictEntry,
    canonicalHash: shortHash(remoteResult.verifiedHash),
    conflictHash: shortHash(localHash),
  }, { location: "conflict-handlers.resolveKeepRemoteCanonical" });

  // Runbook-dependent log — do not remove: runbook 08 asserts keep_both / remote canonical.
  logRule(log, [SyncRules.R1, SyncRules.R2, SyncRules.R4], "conflict resolved: keep_both (remote canonical)", {
    path: localPath,
    canonicalHolder: "remote",
    conflictCopyPath: conflictPath,
    conflictCopyHolder: "local",
    localHash: shortHash(localHash),
    remoteHash: shortHash(remoteResult.verifiedHash),
    conflictRemoteRev: conflictEntry.rev,
  }, { level: "info", location: "conflict-handlers.keepBoth" });

  await updateSyncState(
    store,
    pathLower,
    localPath,
    remoteResult.verifiedHash,
    remoteResult.verifiedHash,
    remoteResult.metadata.rev,
  );
  await updateSyncState(
    store,
    conflictPathLower,
    conflictPath,
    localHash,
    conflictEntry.hash ?? localHash,
    conflictEntry.rev,
  );
  return { conflictSiblingPath: conflictPath };
}

/** keep_both: remote keeps canonical path; local uploaded as conflict copy (R2). */
export async function handleConflictKeepBoth(
  item: SyncPlanItem,
  deps: ConflictHandlerDeps,
): Promise<ConflictHandlerResult> {
  const { fs, remote } = deps;
  const { localPath } = item;

  const { data: localData, hash: localHash } = await readLocalWithHash(fs, localPath);
  const remoteResult = await downloadAndVerify(remote, localPath);
  return resolveConflictKeepRemoteCanonical(item, deps, localData, localHash, remoteResult);
}

/** manual: conflictResolver 콜백으로 사용자에게 위임. 없으면 keep_both fallback */
export async function handleConflictManual(
  item: SyncPlanItem,
  deps: ConflictHandlerDeps,
): Promise<ConflictHandlerResult> {
  const { fs, remote, log } = deps;
  const { localPath } = item;

  if (!deps.conflictResolver) {
    return handleConflictKeepBoth(item, deps);
  }

  const { data: localData, hash: localHash } = await readLocalWithHash(fs, localPath);
  const remoteResult = await downloadAndVerify(remote, localPath);

  const context: ConflictContext = {
    localSize: localData.length,
    remoteSize: remoteResult.data.length,
    remoteMtime: remoteResult.metadata.serverModified,
  };

  const isText = /\.(md|txt|json|css|js|ts|html|xml|yaml|yml|csv|ini|cfg|log|toml)$/i.test(localPath);
  if (isText) {
    const decoder = new TextDecoder();
    context.localContent = decoder.decode(localData);
    context.remoteContent = decoder.decode(remoteResult.data);
  } else {
    context.localData = localData;
    context.remoteData = remoteResult.data;
  }

  const choice = await deps.conflictResolver(localPath, context);

  if (choice === "skip" || !choice) {
    throw new ConflictSkippedError();
  }

  logTemp(log, "P2", "manual conflict — applying keep_both-style outcome", {
    path: localPath,
    choice: typeof choice === "string" ? choice : "merged",
  }, { location: "conflict-handlers.manual" });

  logRule(deps.log, SyncRules.R1, "conflict resolved manually (both sides kept)", {
    path: localPath,
    choice: typeof choice === "string" ? choice : "merged",
    keepsBothSides: true,
  }, { level: "info", location: "conflict-handlers.manual" });

  if (typeof choice === "object" && choice !== null && "type" in choice && choice.type === "merged") {
    return resolveConflictKeepRemoteCanonical(
      item,
      deps,
      choice.content,
      await dropboxContentHashBrowser(choice.content),
      remoteResult,
    );
  }

  return resolveConflictKeepRemoteCanonical(item, deps, localData, localHash, remoteResult);
}

/** 전략 → 핸들러 디스패치 맵 */
type ConflictHandler = (
  item: SyncPlanItem,
  deps: ConflictHandlerDeps,
) => Promise<ConflictHandlerResult>;

const CONFLICT_HANDLERS: Record<ConflictStrategy, ConflictHandler> = {
  keep_both: handleConflictKeepBoth,
  manual: handleConflictManual,
};

/** strategy에 따라 적절한 conflict handler를 호출 */
export function dispatchConflict(
  item: SyncPlanItem,
  deps: ConflictHandlerDeps,
): Promise<ConflictHandlerResult> {
  const strategy = deps.conflictStrategy ?? "keep_both";
  deps.log?.("conflict dispatch", {
    path: item.localPath,
    strategy,
  }, {
    category: SyncLogCategories.conflict,
    ruleId: SyncRules.R1,
    level: "info",
    location: "conflict-handlers.dispatchConflict",
  });
  return CONFLICT_HANDLERS[strategy](item, deps);
}
