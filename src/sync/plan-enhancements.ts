import type {
  FileInfo,
  FolderInfo,
  RemoteEntry,
  SyncAction,
  SyncEntry,
  SyncPlan,
  SyncPlanItem,
} from "../types";
import { emptySyncPlanStats } from "../types";
import {
  logRule,
  SyncRules,
  type SyncMonitorLog,
} from "../debug/sync-monitor";
import { logTemp } from "../debug/temp-log";
import { isCaseOnlyRename } from "./remote-move";

export interface PlanEnhancementInput {
  localFiles: FileInfo[];
  localFolders: FolderInfo[];
  remoteEntries: RemoteEntry[];
  baseEntries: SyncEntry[];
  localDeletedPaths?: Set<string>;
  log?: SyncMonitorLog;
}

function emptyStats(): SyncPlan["stats"] {
  return emptySyncPlanStats();
}

/**
 * Vault / sync-root folder row — createRemoteFolder("/") becomes remote "//"
 * under the Dropbox sync prefix and Dropbox rejects it. Never plan create for root.
 */
export function isSyncRootFolderPath(path: string): boolean {
  const trimmed = path.trim();
  return trimmed === "" || trimmed === "/";
}

function baseDisplayPath(base: SyncEntry | null | undefined): string | null {
  if (!base) return null;
  return base.basePathDisplay ?? base.localPath;
}

/** G6 three-way casing compare on display paths (R8 — never mtime). */
export function classifyCasingAction(
  localPath: string,
  remotePathDisplay: string,
  base: SyncEntry | null,
  log?: SyncMonitorLog,
  pathLower?: string,
): SyncAction | null {
  const baseDisplay = baseDisplayPath(base);
  const localChanged = baseDisplay != null ? localPath !== baseDisplay : localPath !== remotePathDisplay;
  const remoteChanged = baseDisplay != null ? remotePathDisplay !== baseDisplay : false;

  if (!localChanged && !remoteChanged) {
    if (localPath !== remotePathDisplay) {
      // No base history — adopt Dropbox casing.
      logRule(log, SyncRules.R8, "adopting remote casing without base", {
        path: pathLower ?? localPath,
        localPath,
        remotePathDisplay,
      }, { location: "plan-enhancements.classifyCasing" });
      return {
        type: "moveLocal",
        fromPath: localPath,
        toPath: remotePathDisplay,
        reason: "adopt_remote_casing",
      };
    }
    return null;
  }

  if (localChanged && !remoteChanged) {
    logRule(log, SyncRules.R8, "local casing changed — push case-only server move", {
      path: pathLower ?? localPath,
      from: remotePathDisplay,
      to: localPath,
      caseOnly: isCaseOnlyRename(remotePathDisplay, localPath),
    }, { location: "plan-enhancements.classifyCasing" });
    return {
      type: "moveRemote",
      fromPath: remotePathDisplay,
      toPath: localPath,
      reason: "local_casing_changed",
    };
  }

  if (!localChanged && remoteChanged) {
    logRule(log, SyncRules.R8, "remote casing changed — adopt locally", {
      path: pathLower ?? localPath,
      from: localPath,
      to: remotePathDisplay,
    }, { location: "plan-enhancements.classifyCasing" });
    return {
      type: "moveLocal",
      fromPath: localPath,
      toPath: remotePathDisplay,
      reason: "remote_casing_changed",
    };
  }

  // Both changed differently — first landing on Dropbox wins; adopt remote if it moved.
  if (remoteChanged) {
    logRule(log, SyncRules.R8, "both renamed casing — adopting remote (first on Dropbox wins)", {
      path: pathLower ?? localPath,
      localPath,
      remotePathDisplay,
      baseDisplay,
    }, { location: "plan-enhancements.classifyCasing" });
    return {
      type: "moveLocal",
      fromPath: localPath,
      toPath: remotePathDisplay,
      reason: "casing_race_adopt_remote",
    };
  }

  logRule(log, SyncRules.R8, "both renamed casing — pushing local to remote first", {
    path: pathLower ?? localPath,
    localPath,
    remotePathDisplay,
    baseDisplay,
  }, { location: "plan-enhancements.classifyCasing" });
  return {
    type: "moveRemote",
    fromPath: remotePathDisplay,
    toPath: localPath,
    reason: "casing_race_push_local",
  };
}

function isFolderEntry(entry: SyncEntry): boolean {
  return entry.entryKind === "folder";
}

function isFolderRemote(entry: RemoteEntry): boolean {
  return !!entry.isFolder;
}

function pathIsUnderOrEqual(pathLower: string, folderLower: string): boolean {
  return pathLower === folderLower || pathLower.startsWith(`${folderLower}/`);
}

function relativizeUnder(pathLower: string, folderLower: string): string | null {
  if (pathLower === folderLower) return "";
  const prefix = `${folderLower}/`;
  if (!pathLower.startsWith(prefix)) return null;
  return pathLower.slice(prefix.length);
}

function joinUnder(folderLower: string, relative: string): string {
  return relative ? `${folderLower}/${relative}` : folderLower;
}

function pathBasename(pathLower: string): string {
  const slash = pathLower.lastIndexOf("/");
  return slash < 0 ? pathLower : pathLower.slice(slash + 1);
}

/** G14: detect file-vs-folder at the same path_lower. */
function detectPathCollisions(
  localFiles: Map<string, FileInfo>,
  localFolders: Map<string, FolderInfo>,
  remoteMap: Map<string, RemoteEntry>,
  log?: SyncMonitorLog,
): SyncPlanItem[] {
  const items: SyncPlanItem[] = [];
  const checked = new Set<string>();

  for (const pathLower of localFiles.keys()) {
    const remote = remoteMap.get(pathLower);
    if (!remote || remote.deleted) continue;
    if (isFolderRemote(remote)) {
      checked.add(pathLower);
      const local = localFiles.get(pathLower)!;
      logTemp(log, "P5", "file-vs-folder path collision", {
        pathLower,
        localKind: "file",
        remoteKind: "folder",
      }, { location: "plan-enhancements.detectPathCollisions" });
      items.push({
        pathLower,
        localPath: local.path,
        action: {
          type: "pathCollision",
          localKind: "file",
          remoteKind: "folder",
          reason: "file_vs_folder",
        },
      });
    }
  }

  for (const pathLower of localFolders.keys()) {
    if (checked.has(pathLower)) continue;
    const remote = remoteMap.get(pathLower);
    if (!remote || remote.deleted || isFolderRemote(remote)) continue;
    const folder = localFolders.get(pathLower)!;
    logTemp(log, "P5", "folder-vs-file path collision", {
      pathLower,
      localKind: "folder",
      remoteKind: "file",
    }, { location: "plan-enhancements.detectPathCollisions" });
    items.push({
      pathLower,
      localPath: folder.path,
      action: {
        type: "pathCollision",
        localKind: "folder",
        remoteKind: "file",
        reason: "folder_vs_file",
      },
    });
  }

  return items;
}

interface RenameMatch {
  fromPathLower: string;
  toPathLower: string;
  fromDisplay: string;
  toDisplay: string;
  hash: string;
  side: "local" | "remote" | "both";
}

/** G7: pair vanished base paths with new paths sharing the same content hash. */
function detectContentRenames(
  localMap: Map<string, FileInfo>,
  remoteMap: Map<string, RemoteEntry>,
  baseMap: Map<string, SyncEntry>,
  consumedPaths: Set<string>,
  log?: SyncMonitorLog,
): RenameMatch[] {
  const matches: RenameMatch[] = [];
  const hashToLocal = new Map<string, FileInfo[]>();
  const hashToRemote = new Map<string, RemoteEntry[]>();

  for (const file of localMap.values()) {
    const list = hashToLocal.get(file.hash) ?? [];
    list.push(file);
    hashToLocal.set(file.hash, list);
  }

  for (const entry of remoteMap.values()) {
    if (entry.deleted || entry.isFolder || !entry.hash) continue;
    const list = hashToRemote.get(entry.hash) ?? [];
    list.push(entry);
    hashToRemote.set(entry.hash, list);
  }

  for (const base of baseMap.values()) {
    if (isFolderEntry(base)) continue;
    const hash = base.baseLocalHash ?? base.baseRemoteHash;
    if (!hash) continue;
    if (consumedPaths.has(base.pathLower)) continue;

    const localAtBase = localMap.has(base.pathLower);
    const remoteAtBase = remoteMap.has(base.pathLower);
    // Skip only when both sides still have the base path — a local rename leaves
    // remote at the old path, and a remote rename leaves local there.
    if (localAtBase && remoteAtBase) continue;

    const localCandidates = (hashToLocal.get(hash) ?? []).filter(
      (f) => f.pathLower !== base.pathLower,
    );
    const remoteCandidates = (hashToRemote.get(hash) ?? []).filter(
      (e) => e.pathLower !== base.pathLower,
    );

    // Prefer a unique same-hash candidate so duplicate content cannot false-pair.
    const localMatch = localCandidates.length === 1 ? localCandidates[0] : undefined;
    const remoteMatch = remoteCandidates.length === 1 ? remoteCandidates[0] : undefined;

    // #region agent log
    logTemp(log, "P5", "G7 rename candidate probe", {
      runId: "post-fix",
      hypothesisId: "H1-H2",
      base: base.pathLower,
      hash: hash.slice(0, 8),
      localAtBase,
      remoteAtBase,
      localCandidateCount: localCandidates.length,
      remoteCandidateCount: remoteCandidates.length,
      localCandidatesSample: localCandidates.map((f) => f.pathLower).slice(0, 3),
      remoteCandidatesSample: remoteCandidates.map((e) => e.pathLower).slice(0, 3),
    }, { location: "plan-enhancements.detectContentRenames", hypothesisId: "H1" });
    // #endregion

    // Both sides left base and landed on the same new path (peer already synced).
    if (
      localMatch
      && remoteMatch
      && localMatch.pathLower === remoteMatch.pathLower
      && !localAtBase
      && !remoteAtBase
    ) {
      matches.push({
        fromPathLower: base.pathLower,
        toPathLower: localMatch.pathLower,
        fromDisplay: base.localPath,
        toDisplay: localMatch.path,
        hash,
        side: "both",
      });
      consumedPaths.add(base.pathLower);
      consumedPaths.add(localMatch.pathLower);
      continue;
    }

    // Local rename/move: old path gone locally, still on remote; unique new local path.
    if (localMatch && !localAtBase) {
      const remoteStillAtBase = remoteMap.get(base.pathLower);
      const willMatch = Boolean(
        remoteStillAtBase
        && !remoteStillAtBase.deleted
        && remoteStillAtBase.hash === hash
        && !remoteMap.has(localMatch.pathLower),
      );
      // #region agent log
      logTemp(log, "P5", "G7 local-branch attempt", {
        runId: "post-fix",
        hypothesisId: "H2",
        base: base.pathLower,
        to: localMatch.pathLower,
        remoteStillAtBase: Boolean(remoteStillAtBase),
        remoteHashMatch: remoteStillAtBase?.hash === hash,
        destFreeOnRemote: !remoteMap.has(localMatch.pathLower),
        willMatch,
      }, { location: "plan-enhancements.detectContentRenames", hypothesisId: "H2" });
      // #endregion
      if (willMatch) {
        matches.push({
          fromPathLower: base.pathLower,
          toPathLower: localMatch.pathLower,
          fromDisplay: base.localPath,
          toDisplay: localMatch.path,
          hash,
          side: "local",
        });
        consumedPaths.add(base.pathLower);
        consumedPaths.add(localMatch.pathLower);
      }
    } else if (remoteMatch && !remoteAtBase) {
      // Remote rename/move: old path gone remotely, still local; unique new remote path.
      const localStillAtBase = localMap.get(base.pathLower);
      const willMatch = Boolean(
        localStillAtBase
        && localStillAtBase.hash === hash
        && !localMap.has(remoteMatch.pathLower),
      );
      // #region agent log
      logTemp(log, "P5", "G7 remote-branch attempt", {
        runId: "post-fix",
        hypothesisId: "H2",
        base: base.pathLower,
        to: remoteMatch.pathLower,
        localStillAtBase: Boolean(localStillAtBase),
        localHashMatch: localStillAtBase?.hash === hash,
        destFreeOnLocal: !localMap.has(remoteMatch.pathLower),
        willMatch,
      }, { location: "plan-enhancements.detectContentRenames", hypothesisId: "H2" });
      // #endregion
      if (willMatch) {
        matches.push({
          fromPathLower: base.pathLower,
          toPathLower: remoteMatch.pathLower,
          fromDisplay: base.localPath,
          toDisplay: remoteMatch.pathDisplay,
          hash,
          side: "remote",
        });
        consumedPaths.add(base.pathLower);
        consumedPaths.add(remoteMatch.pathLower);
      }
    }
  }

  // Cold sync: no base row — pair absent+appeared hashes (P5).
  for (const [hash, locals] of hashToLocal) {
    for (const local of locals) {
      if (consumedPaths.has(local.pathLower)) continue;
      if (baseMap.has(local.pathLower)) continue;
      const remotes = (hashToRemote.get(hash) ?? []).filter(
        (r) => r.pathLower !== local.pathLower && !localMap.has(r.pathLower),
      );
      if (remotes.length !== 1) continue;
      const remote = remotes[0]!;
      // #region agent log
      // H5: warm renames fail cold path when old remote path still has a base row.
      logTemp(log, "P5", "G7 cold-path candidate", {
        hypothesisId: "H5",
        local: local.pathLower,
        remote: remote.pathLower,
        hash: hash.slice(0, 8),
        remoteHasBase: baseMap.has(remote.pathLower),
        willSkipForBase: baseMap.has(remote.pathLower),
      }, { location: "plan-enhancements.detectContentRenames", hypothesisId: "H5" });
      // #endregion
      if (baseMap.has(remote.pathLower)) continue;
      matches.push({
        fromPathLower: remote.pathLower,
        toPathLower: local.pathLower,
        fromDisplay: remote.pathDisplay,
        toDisplay: local.path,
        hash,
        side: "both",
      });
      consumedPaths.add(remote.pathLower);
      consumedPaths.add(local.pathLower);
    }
  }

  // #region agent log
  logTemp(log, "P5", "G7 detectContentRenames result", {
    runId: "post-fix",
    hypothesisId: "H1-H5",
    matchCount: matches.length,
    matches: matches.map((m) => ({
      from: m.fromPathLower,
      to: m.toPathLower,
      side: m.side,
      hash: m.hash.slice(0, 8),
    })),
  }, { location: "plan-enhancements.detectContentRenames", hypothesisId: "H1" });
  // #endregion

  return matches;
}

function applyRenameMatches(
  plan: SyncPlan,
  matches: RenameMatch[],
  log?: SyncMonitorLog,
): SyncPlan {
  if (matches.length === 0) return plan;

  const suppressPathLowers = new Set<string>();
  for (const match of matches) {
    suppressPathLowers.add(match.fromPathLower);
    suppressPathLowers.add(match.toPathLower);
  }

  const filteredItems = plan.items.filter((item) => {
    if (!suppressPathLowers.has(item.pathLower)) return true;
    const action = item.action.type;
    return action === "noop" || action === "recordBase";
  });

  const stats = emptyStats();
  const items: SyncPlanItem[] = [...filteredItems];

  for (const match of matches) {
    let action: SyncAction;
    if (match.side === "local" || match.side === "both") {
      action = {
        type: "moveRemote",
        fromPath: match.fromDisplay,
        toPath: match.toDisplay,
        reason: "content_rename_detected",
      };
    } else {
      action = {
        type: "moveLocal",
        fromPath: match.fromDisplay,
        toPath: match.toDisplay,
        reason: "content_rename_detected",
      };
    }
    logTemp(log, "P5", "content-similarity rename match", {
      from: match.fromDisplay,
      to: match.toDisplay,
      hash: match.hash.slice(0, 8),
      side: match.side,
    }, { location: "plan-enhancements.applyRenameMatches" });
    items.push({
      pathLower: match.toPathLower,
      localPath: match.toDisplay,
      action,
    });
    stats[action.type]++;
  }

  for (const item of filteredItems) {
    const t = item.action.type;
    if (t in stats && t !== "moveLocal" && t !== "moveRemote") {
      (stats as Record<string, number>)[t]++;
    }
  }

  return { items, stats };
}

interface FolderRenameMatch {
  fromPathLower: string;
  toPathLower: string;
  fromDisplay: string;
  toDisplay: string;
  side: "local" | "remote";
  fileCount: number;
}

type FolderRenameCandidate = {
  from: SyncEntry;
  toPathLower: string;
  toDisplay: string;
  fileCount: number;
  basenameMatch: boolean;
  side: "local" | "remote";
};

/**
 * G8: detect populated folder rename/move by preserved relative tree under a
 * new path. Local → moveRemoteFolder; remote (peer) → moveLocalFolder.
 * Strict same-relative-path + hash only; empty folders and compound
 * folder+inner renames fall back to create+delete (or G7 file moves).
 */
function detectFolderRenames(
  localFolders: Map<string, FolderInfo>,
  remoteFolders: Map<string, RemoteEntry>,
  baseFolders: Map<string, SyncEntry>,
  localFiles: Map<string, FileInfo>,
  remoteFiles: Map<string, RemoteEntry>,
  baseFiles: SyncEntry[],
  localDeletedPaths: Set<string> | undefined,
): FolderRenameMatch[] {
  const matches: FolderRenameMatch[] = [];
  const consumed = new Set<string>();
  const candidates: FolderRenameCandidate[] = [];

  // Local renamed/moved: old path gone locally, still on remote; new local folder.
  // Skip sync root — pairing remnant shells with ""/"/" produced malformed Dropbox moves.
  const oldLocals = [...baseFolders.values()].filter((base) => {
    if (isSyncRootFolderPath(base.pathLower)) return false;
    if (localFolders.has(base.pathLower)) return false;
    if (!remoteFolders.has(base.pathLower)) return false;
    if (localDeletedPaths?.has(base.pathLower)) return false;
    return true;
  });
  const newLocals = [...localFolders.values()].filter(
    (folder) =>
      !isSyncRootFolderPath(folder.pathLower)
      && !remoteFolders.has(folder.pathLower),
  );
  for (const from of oldLocals) {
    for (const to of newLocals) {
      const scored = scoreLocalFolderRename(
        from.pathLower,
        to.pathLower,
        baseFolders,
        baseFiles,
        localFolders,
        localFiles,
      );
      if (!scored.ok) continue;
      candidates.push({
        from,
        toPathLower: to.pathLower,
        toDisplay: to.path,
        fileCount: scored.fileCount,
        basenameMatch: pathBasename(from.pathLower) === pathBasename(to.pathLower),
        side: "local",
      });
    }
  }

  // Remote (peer) renamed/moved: old path still local, gone on remote; new remote folder.
  const oldRemotes = [...baseFolders.values()].filter((base) => {
    if (isSyncRootFolderPath(base.pathLower)) return false;
    if (!localFolders.has(base.pathLower)) return false;
    if (remoteFolders.has(base.pathLower)) return false;
    if (localDeletedPaths?.has(base.pathLower)) return false;
    return true;
  });
  const newRemotes = [...remoteFolders.values()].filter(
    (folder) =>
      !isSyncRootFolderPath(folder.pathLower)
      && !localFolders.has(folder.pathLower),
  );
  for (const from of oldRemotes) {
    for (const to of newRemotes) {
      const scored = scoreRemoteFolderRename(
        from.pathLower,
        to.pathLower,
        baseFolders,
        baseFiles,
        remoteFolders,
        remoteFiles,
      );
      if (!scored.ok) continue;
      candidates.push({
        from,
        toPathLower: to.pathLower,
        toDisplay: to.pathDisplay,
        fileCount: scored.fileCount,
        basenameMatch: pathBasename(from.pathLower) === pathBasename(to.pathLower),
        side: "remote",
      });
    }
  }

  // Prefer parent folders (shorter paths) so one move covers the intact tree.
  // Exact basename match ranks above fileCount when path lengths tie.
  candidates.sort((a, b) => {
    const len = a.from.pathLower.length - b.from.pathLower.length;
    if (len !== 0) return len;
    if (a.basenameMatch !== b.basenameMatch) return a.basenameMatch ? -1 : 1;
    return b.fileCount - a.fileCount;
  });

  for (const candidate of candidates) {
    // Populated folders only — empty rename has no content signal and must not
    // claim a non-empty destination (create+delete fallback instead).
    if (candidate.fileCount === 0) continue;
    if (consumed.has(candidate.from.pathLower) || consumed.has(candidate.toPathLower)) {
      continue;
    }
    if ([...consumed].some((root) =>
      pathIsUnderOrEqual(candidate.from.pathLower, root)
      || pathIsUnderOrEqual(candidate.toPathLower, root)
    )) {
      continue;
    }

    const fromDisplay = candidate.side === "local"
      ? (
        remoteFolders.get(candidate.from.pathLower)?.pathDisplay
        ?? candidate.from.basePathDisplay
        ?? candidate.from.localPath
      )
      : (
        localFolders.get(candidate.from.pathLower)?.path
        ?? candidate.from.basePathDisplay
        ?? candidate.from.localPath
      );

    matches.push({
      fromPathLower: candidate.from.pathLower,
      toPathLower: candidate.toPathLower,
      fromDisplay,
      toDisplay: candidate.toDisplay,
      side: candidate.side,
      fileCount: candidate.fileCount,
    });
    consumed.add(candidate.from.pathLower);
    consumed.add(candidate.toPathLower);
  }

  return matches;
}

/**
 * Strict populated folder score: every base file under `from` must exist under
 * `to` at the same relative path with matching hash; destination must not hold
 * unmatched extra files (bijection). Nested base folders must exist under `to`.
 * Folder+inner rename in one window fails here on purpose → create+delete / G7.
 */
function scoreLocalFolderRename(
  fromLower: string,
  toLower: string,
  baseFolders: Map<string, SyncEntry>,
  baseFiles: SyncEntry[],
  localFolders: Map<string, FolderInfo>,
  localFiles: Map<string, FileInfo>,
): { ok: boolean; fileCount: number } {
  const unmatchedLocal = new Map<string, FileInfo>();
  for (const local of localFiles.values()) {
    const relative = relativizeUnder(local.pathLower, toLower);
    if (relative === null || relative === "") continue;
    unmatchedLocal.set(local.pathLower, local);
  }

  let fileCount = 0;
  for (const base of baseFiles) {
    if (isFolderEntry(base)) continue;
    const relative = relativizeUnder(base.pathLower, fromLower);
    if (relative === null || relative === "") continue;
    const expectedLower = joinUnder(toLower, relative);
    const local = unmatchedLocal.get(expectedLower);
    if (!local) return { ok: false, fileCount: 0 };
    const hash = base.baseLocalHash ?? base.baseRemoteHash;
    if (hash && local.hash !== hash) return { ok: false, fileCount: 0 };
    unmatchedLocal.delete(expectedLower);
    fileCount++;
  }
  // Bijection: refuse when destination has files outside this folder's tree
  // (e.g. notes must not claim a larger seeds-renamed parent that still holds bulk).
  if (unmatchedLocal.size > 0) return { ok: false, fileCount: 0 };
  // Empty trees are create+delete — not a folder move.
  if (fileCount === 0) return { ok: false, fileCount: 0 };

  for (const base of baseFolders.values()) {
    const relative = relativizeUnder(base.pathLower, fromLower);
    if (relative === null || relative === "") continue;
    if (!localFolders.has(joinUnder(toLower, relative))) {
      return { ok: false, fileCount: 0 };
    }
  }
  return { ok: true, fileCount };
}

/** Same strict rules as scoreLocalFolderRename against the remote tree. */
function scoreRemoteFolderRename(
  fromLower: string,
  toLower: string,
  baseFolders: Map<string, SyncEntry>,
  baseFiles: SyncEntry[],
  remoteFolders: Map<string, RemoteEntry>,
  remoteFiles: Map<string, RemoteEntry>,
): { ok: boolean; fileCount: number } {
  const unmatchedRemote = new Map<string, RemoteEntry>();
  for (const remote of remoteFiles.values()) {
    if (remote.deleted || remote.isFolder || !remote.hash) continue;
    const relative = relativizeUnder(remote.pathLower, toLower);
    if (relative === null || relative === "") continue;
    unmatchedRemote.set(remote.pathLower, remote);
  }

  let fileCount = 0;
  for (const base of baseFiles) {
    if (isFolderEntry(base)) continue;
    const relative = relativizeUnder(base.pathLower, fromLower);
    if (relative === null || relative === "") continue;
    const expectedLower = joinUnder(toLower, relative);
    const remote = unmatchedRemote.get(expectedLower);
    if (!remote) return { ok: false, fileCount: 0 };
    const hash = base.baseLocalHash ?? base.baseRemoteHash;
    if (hash && remote.hash !== hash) return { ok: false, fileCount: 0 };
    unmatchedRemote.delete(expectedLower);
    fileCount++;
  }
  if (unmatchedRemote.size > 0) return { ok: false, fileCount: 0 };
  if (fileCount === 0) return { ok: false, fileCount: 0 };

  for (const base of baseFolders.values()) {
    const relative = relativizeUnder(base.pathLower, fromLower);
    if (relative === null || relative === "") continue;
    if (!remoteFolders.has(joinUnder(toLower, relative))) {
      return { ok: false, fileCount: 0 };
    }
  }
  return { ok: true, fileCount };
}

function applyFolderRenameMatches(
  plan: SyncPlan,
  matches: FolderRenameMatch[],
): SyncPlan {
  if (matches.length === 0) return plan;

  // Drop per-file moves/uploads/deletes covered by a folder-level move.
  const filteredItems = plan.items.filter((item) => {
    const covered = matches.some((match) =>
      pathIsUnderOrEqual(item.pathLower, match.fromPathLower)
      || pathIsUnderOrEqual(item.pathLower, match.toPathLower)
      || (
        "fromPath" in item.action
        && typeof (item.action as { fromPath?: string }).fromPath === "string"
        && pathIsUnderOrEqual(
          (item.action as { fromPath: string }).fromPath.toLowerCase(),
          match.fromPathLower,
        )
      )
    );
    if (!covered) return true;
    const action = item.action.type;
    return action === "noop" || action === "recordBase";
  });

  const stats = emptyStats();
  const items: SyncPlanItem[] = [...filteredItems];

  for (const match of matches) {
    // Local rename → push folder move to Dropbox; remote rename → adopt locally.
    const action: SyncAction = match.side === "local"
      ? {
          type: "moveRemoteFolder",
          fromPath: match.fromDisplay,
          toPath: match.toDisplay,
          reason: "folder_rename_detected",
        }
      : {
          type: "moveLocalFolder",
          fromPath: match.fromDisplay,
          toPath: match.toDisplay,
          reason: "folder_rename_detected",
        };
    items.push({
      pathLower: match.toPathLower,
      localPath: match.toDisplay,
      action,
    });
    if (action.type === "moveRemoteFolder") stats.moveRemoteFolder++;
    else stats.moveLocalFolder++;
  }

  for (const item of filteredItems) {
    const t = item.action.type;
    if (t in stats) (stats as Record<string, number>)[t]++;
  }

  return { items, stats };
}

function planFolderItems(
  input: PlanEnhancementInput,
  /** path_lower of file items already planned as deleteLocal in this enhance pass. */
  plannedDeleteLocalPathLowers: Set<string> = new Set(),
  /** Folder paths (and trees) already handled by moveRemoteFolder / moveLocalFolder. */
  folderMoveConsumed: Set<string> = new Set(),
): SyncPlanItem[] {
  const { localFolders, localFiles, remoteEntries, baseEntries, localDeletedPaths, log } = input;
  const localMap = new Map(localFolders.map((f) => [f.pathLower, f]));
  const remoteMap = new Map<string, RemoteEntry>();
  for (const entry of remoteEntries) {
    if (entry.isFolder && !entry.deleted) {
      remoteMap.set(entry.pathLower, entry);
    }
  }
  const baseMap = new Map(
    baseEntries.filter(isFolderEntry).map((e) => [e.pathLower, e]),
  );
  const localFilesUnder = (folderPathLower: string): FileInfo[] => {
    const prefix = `${folderPathLower}/`;
    return localFiles.filter((f) => f.pathLower.startsWith(prefix));
  };
  const hasLocalFilesUnder = (folderPathLower: string): boolean =>
    localFilesUnder(folderPathLower).length > 0;

  // Local folder gone while base still remembers it: treat as tree wipe unless
  // orphan files remain under the path (then restore the folder shell only).
  // Vault folder delete intents are often dropped as out-of-scope, so inference
  // must cover the same case as deleteIntended for full-folder deletes.
  // Requires accurate localFolders (config dirs via disk scan) — missing
  // `.obsidian/plugins` in the vault index previously caused false wipes.
  const shouldInferRemoteFolderDelete = (folderPathLower: string): boolean =>
    !hasLocalFilesUnder(folderPathLower);

  /**
   * Remote folder wiped: remove local folder when empty, or when every local
   * child file is already planned deleteLocal (same cycle as the peer wipe).
   * Unmanaged local files under the path still block folder delete (G8 row 65).
   */
  const shouldDeleteLocalFolderForRemoteWipe = (folderPathLower: string): boolean => {
    const children = localFilesUnder(folderPathLower);
    if (children.length === 0) return true;
    return children.every((f) => plannedDeleteLocalPathLowers.has(f.pathLower));
  };

  const allPathLowers = new Set<string>();
  for (const k of localMap.keys()) allPathLowers.add(k);
  for (const k of remoteMap.keys()) allPathLowers.add(k);
  for (const k of baseMap.keys()) allPathLowers.add(k);

  const items: SyncPlanItem[] = [];

  const isConsumedByFolderMove = (pathLower: string): boolean =>
    [...folderMoveConsumed].some((root) => pathIsUnderOrEqual(pathLower, root));

  for (const pathLower of allPathLowers) {
    if (isConsumedByFolderMove(pathLower)) continue;
    const local = localMap.get(pathLower);
    const remote = remoteMap.get(pathLower);
    const base = baseMap.get(pathLower);
    const localPath = local?.path ?? remote?.pathDisplay ?? base?.localPath ?? pathLower;
    const localExists = !!local;
    const remoteExists = !!remote;
    const deleteIntended = localDeletedPaths?.has(pathLower);

    if (localExists && remoteExists) {
      const casing = classifyCasingAction(
        local!.path,
        remote!.pathDisplay,
        base ?? null,
        log,
        pathLower,
      );
      if (casing && (casing.type === "moveLocal" || casing.type === "moveRemote")) {
        const folderAction: SyncAction =
          casing.type === "moveLocal"
            ? {
                type: "moveLocalFolder",
                fromPath: casing.fromPath,
                toPath: casing.toPath,
                reason: casing.reason,
              }
            : {
                type: "moveRemoteFolder",
                fromPath: casing.fromPath,
                toPath: casing.toPath,
                reason: casing.reason,
              };
        items.push({ pathLower, localPath, action: folderAction });
      }
      continue;
    }

    if (localExists && !remoteExists) {
      // G8: peer removed the remote folder. Delete local folder when empty, or in
      // the same cycle when all synced children are already planned deleteLocal
      // (otherwise files delete and the empty shell is left behind until next sync).
      if (!deleteIntended && shouldDeleteLocalFolderForRemoteWipe(pathLower)) {
        const children = localFilesUnder(pathLower);
        if (base || children.length > 0) {
          logRule(log, SyncRules.R14, children.length > 0
            ? "deleteLocalFolder with planned child deletes — remote folder wipe"
            : "deleteLocalFolder — remote folder gone, local empty", {
            path: pathLower,
            childDeletes: children.length,
            hasBase: !!base,
          }, { location: "plan-enhancements.planFolderItems" });
          items.push({
            pathLower,
            localPath,
            action: { type: "deleteLocalFolder", reason: "deleted_on_remote" },
          });
          continue;
        }
      }
      if (!base && !isSyncRootFolderPath(pathLower) && !isSyncRootFolderPath(localPath)) {
        // Root already exists as the sync folder — create_folder("/") → remote "//".
        items.push({
          pathLower,
          localPath,
          action: {
            type: "createRemoteFolder",
            reason: "new_local_folder",
          },
        });
      }
      continue;
    }

    if (!localExists && remoteExists) {
      if (deleteIntended || (base && shouldInferRemoteFolderDelete(pathLower))) {
        const inferred = !deleteIntended && !!base;
        logRule(log, SyncRules.R14, inferred
          ? "inferred deleteRemoteFolder — local tree wipe without folder delete intent"
          : "deleteRemoteFolder — folder delete intended", {
          path: pathLower,
          deleteIntended: !!deleteIntended,
          inferred,
        }, { location: "plan-enhancements.planFolderItems" });
        items.push({
          pathLower,
          localPath,
          action: {
            type: "deleteRemoteFolder",
            reason: deleteIntended ? "deleted_on_local" : "inferred_local_tree_wipe",
          },
        });
      } else if (!isSyncRootFolderPath(pathLower) && !isSyncRootFolderPath(localPath)) {
        // Local vault root is already present — do not mkdir "".
        items.push({
          pathLower,
          localPath,
          action: { type: "createLocalFolder", reason: base ? "folder_restored" : "new_remote_folder" },
        });
      }
      continue;
    }

    if (base && deleteIntended && remoteExists === false) {
      items.push({
        pathLower,
        localPath,
        action: { type: "deleteRemoteFolder", reason: "deleted_on_local" },
      });
    } else if (base && !deleteIntended && !localExists) {
      items.push({
        pathLower,
        localPath,
        action: { type: "deleteLocalFolder", reason: "deleted_on_remote" },
      });
    }
  }

  return items;
}

function applyCasingToFilePlan(plan: SyncPlan, input: PlanEnhancementInput): SyncPlan {
  const remoteMap = new Map(input.remoteEntries.map((e) => [e.pathLower, e]));
  const baseMap = new Map(input.baseEntries.map((e) => [e.pathLower, e]));
  const localMap = new Map(input.localFiles.map((f) => [f.pathLower, f]));

  const items: SyncPlanItem[] = [];
  const stats = { ...plan.stats };

  for (const item of plan.items) {
    if (item.action.type !== "noop" && item.action.type !== "recordBase") {
      items.push(item);
      continue;
    }

    const local = localMap.get(item.pathLower);
    const remote = remoteMap.get(item.pathLower);
    if (!local || !remote || remote.deleted || remote.isFolder) {
      items.push(item);
      continue;
    }
    if (local.hash !== (remote.hash ?? "")) {
      items.push(item);
      continue;
    }

    const casing = classifyCasingAction(
      local.path,
      remote.pathDisplay,
      baseMap.get(item.pathLower) ?? null,
      input.log,
      item.pathLower,
    );

    if (!casing) {
      items.push(item);
      continue;
    }

    if (item.action.type === "noop") {
      stats.noop = Math.max(0, stats.noop - 1);
    } else {
      stats.recordBase = Math.max(0, stats.recordBase - 1);
    }
    stats[casing.type]++;
    items.push({ ...item, action: casing });
  }

  return { items, stats };
}

/**
 * Post-planner pass: G6 casing, G7 rename detection, G8 folders, G14 collisions.
 * Manual and live sync share this path (P5).
 */
export function enhanceSyncPlan(basePlan: SyncPlan, input: PlanEnhancementInput): SyncPlan {
  const remoteMap = new Map(input.remoteEntries.map((e) => [e.pathLower, e]));
  const localMap = new Map(input.localFiles.map((f) => [f.pathLower, f]));
  const localFolderMap = new Map(input.localFolders.map((f) => [f.pathLower, f]));
  const baseMap = new Map(input.baseEntries.map((e) => [e.pathLower, e]));

  logTemp(input.log, "P5", "enhanceSyncPlan start", {
    fileItems: basePlan.items.length,
    localFolders: input.localFolders.length,
    remoteFolders: input.remoteEntries.filter((e) => e.isFolder && !e.deleted).length,
  }, { location: "plan-enhancements.enhanceSyncPlan" });

  let plan = applyCasingToFilePlan(basePlan, input);

  const remoteFolders = new Map(
    input.remoteEntries
      .filter((e) => e.isFolder && !e.deleted)
      .map((e) => [e.pathLower, e]),
  );
  const remoteFiles = new Map(
    input.remoteEntries
      .filter((e) => !e.isFolder && !e.deleted && !!e.hash)
      .map((e) => [e.pathLower, e]),
  );
  const baseFolders = new Map(
    input.baseEntries.filter(isFolderEntry).map((e) => [e.pathLower, e]),
  );
  const baseFiles = input.baseEntries.filter((e) => !isFolderEntry(e));

  // G8 folder moves first — one folder move covers the tree and avoids
  // create*Folder + N file moves + delete*Folder.
  const folderMatches = detectFolderRenames(
    localFolderMap,
    remoteFolders,
    baseFolders,
    localMap,
    remoteFiles,
    baseFiles,
    input.localDeletedPaths,
  );

  const consumedPaths = new Set<string>();
  for (const match of folderMatches) {
    for (const pathLower of baseMap.keys()) {
      if (
        pathIsUnderOrEqual(pathLower, match.fromPathLower)
        || pathIsUnderOrEqual(pathLower, match.toPathLower)
      ) {
        consumedPaths.add(pathLower);
      }
    }
    for (const pathLower of localMap.keys()) {
      if (
        pathIsUnderOrEqual(pathLower, match.fromPathLower)
        || pathIsUnderOrEqual(pathLower, match.toPathLower)
      ) {
        consumedPaths.add(pathLower);
      }
    }
    // Peer folder moves: suppress G7 file pairs that target the new remote tree.
    for (const pathLower of remoteMap.keys()) {
      if (
        pathIsUnderOrEqual(pathLower, match.fromPathLower)
        || pathIsUnderOrEqual(pathLower, match.toPathLower)
      ) {
        consumedPaths.add(pathLower);
      }
    }
  }

  const renameMatches = detectContentRenames(
    localMap,
    remoteMap,
    baseMap,
    consumedPaths,
    input.log,
  );
  plan = applyRenameMatches(plan, renameMatches, input.log);
  plan = applyFolderRenameMatches(plan, folderMatches);

  const collisionItems = detectPathCollisions(localMap, localFolderMap, remoteMap, input.log);
  const plannedDeleteLocalPathLowers = new Set(
    plan.items
      .filter((item) => item.action.type === "deleteLocal")
      .map((item) => item.pathLower),
  );
  const folderMoveConsumed = new Set<string>();
  for (const match of folderMatches) {
    folderMoveConsumed.add(match.fromPathLower);
    folderMoveConsumed.add(match.toPathLower);
  }
  const folderItems = planFolderItems(
    input,
    plannedDeleteLocalPathLowers,
    folderMoveConsumed,
  );

  const collisionPathLowers = new Set(collisionItems.map((i) => i.pathLower));
  const filteredPlanItems = plan.items.filter((item) => !collisionPathLowers.has(item.pathLower));

  const stats = { ...plan.stats };
  for (const item of collisionItems) stats.pathCollision++;
  for (const item of folderItems) {
    const t = item.action.type;
    if (t in stats) (stats as Record<string, number>)[t]++;
  }

  return {
    items: [...filteredPlanItems, ...collisionItems, ...folderItems],
    stats,
  };
}
