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
    if (localMap.has(base.pathLower) || remoteMap.has(base.pathLower)) continue;
    if (consumedPaths.has(base.pathLower)) continue;

    const localCandidates = (hashToLocal.get(hash) ?? []).filter(
      (f) => f.pathLower !== base.pathLower,
    );
    const remoteCandidates = (hashToRemote.get(hash) ?? []).filter(
      (e) => e.pathLower !== base.pathLower,
    );

    const localMatch = localCandidates[0];
    const remoteMatch = remoteCandidates[0];

    if (localMatch && remoteMatch && localMatch.pathLower === remoteMatch.pathLower) {
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

    if (localMatch && !remoteMap.has(base.pathLower)) {
      const remoteStillAtBase = remoteMap.get(base.pathLower);
      if (remoteStillAtBase && !remoteStillAtBase.deleted && remoteStillAtBase.hash === hash) {
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
    } else if (remoteMatch && !localMap.has(base.pathLower)) {
      const localStillAtBase = localMap.get(base.pathLower);
      if (localStillAtBase && localStillAtBase.hash === hash) {
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

function planFolderItems(input: PlanEnhancementInput): SyncPlanItem[] {
  const { localFolders, remoteEntries, baseEntries, localDeletedPaths, log } = input;
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

  const allPathLowers = new Set<string>();
  for (const k of localMap.keys()) allPathLowers.add(k);
  for (const k of remoteMap.keys()) allPathLowers.add(k);
  for (const k of baseMap.keys()) allPathLowers.add(k);

  const items: SyncPlanItem[] = [];

  for (const pathLower of allPathLowers) {
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
      // G8: peer removed the remote folder — delete local empty folder.
      // Brand-new local folders (!base) still createRemoteFolder; do not re-upload
      // an empty folder we already had in base after a remote delete.
      if (base && !deleteIntended) {
        items.push({
          pathLower,
          localPath,
          action: { type: "deleteLocalFolder", reason: "deleted_on_remote" },
        });
      } else {
        items.push({
          pathLower,
          localPath,
          action: {
            type: "createRemoteFolder",
            reason: base ? "folder_restored" : "new_local_folder",
          },
        });
      }
      continue;
    }

    if (!localExists && remoteExists) {
      if (deleteIntended) {
        items.push({
          pathLower,
          localPath,
          action: { type: "deleteRemoteFolder", reason: "deleted_on_local" },
        });
      } else {
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

  // Empty folder rename: base folder gone locally, new local folder, remote still at old path.
  for (const base of baseMap.values()) {
    if (localMap.has(base.pathLower) || remoteMap.has(base.pathLower)) continue;
    if (localDeletedPaths?.has(base.pathLower)) continue;
    const remoteAtBase = remoteMap.get(base.pathLower);
    if (!remoteAtBase) continue;

    for (const local of localMap.values()) {
      if (baseMap.has(local.pathLower)) continue;
      if (remoteMap.has(local.pathLower)) continue;
      items.push({
        pathLower: local.pathLower,
        localPath: local.path,
        action: {
          type: "moveRemoteFolder",
          fromPath: base.localPath,
          toPath: local.path,
          reason: "empty_folder_rename",
        },
      });
      break;
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

  const consumedPaths = new Set<string>();
  const renameMatches = detectContentRenames(localMap, remoteMap, baseMap, consumedPaths);
  plan = applyRenameMatches(plan, renameMatches, input.log);

  const collisionItems = detectPathCollisions(localMap, localFolderMap, remoteMap, input.log);
  const folderItems = planFolderItems(input);

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
