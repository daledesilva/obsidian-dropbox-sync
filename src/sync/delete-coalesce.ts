import type { SyncPlanItem } from "../types";

/** Minimum files under a folder before we prefer a folder delete over file deletes. */
const MIN_FOLDER_COVER_COUNT = 2;

export interface CoalesceDeleteRemoteInput {
  deleteRemoteItems: SyncPlanItem[];
  /** Non-deleted remote file path_lowers in sync scope for this cycle. */
  existingRemotePathLowers: Iterable<string>;
  /** Other actionable plan paths that must not sit under a coalesced folder. */
  blockingPathLowers: Iterable<string>;
}

export interface CoalesceDeleteRemoteResult {
  /** Vault-relative folder paths to delete (never "" or "/"). */
  folderPaths: string[];
  /** deleteRemote items not covered by any chosen folder. */
  remainingFileItems: SyncPlanItem[];
  /** folder pathLower → covered original plan items. */
  folderToCoveredItems: Map<string, SyncPlanItem[]>;
}

/**
 * Union path_lowers for multi-section coalesce snapshots.
 * Never drops prior paths when a later scoped section contributes nothing.
 */
export function unionPathLowers(
  existing: Iterable<string>,
  additions: Iterable<string>,
): string[] {
  const set = new Set<string>();
  for (const path of existing) {
    const lower = path.toLowerCase();
    if (lower) set.add(lower);
  }
  for (const path of additions) {
    const lower = path.toLowerCase();
    if (lower) set.add(lower);
  }
  return [...set];
}

/**
 * Collapse complete remote delete subtrees into folder deletes.
 * Execution optimization only — callers must still expand results to the original
 * file-level SyncPlanItems for delete-log and UI accounting.
 */
export function coalesceDeleteRemote(
  input: CoalesceDeleteRemoteInput,
): CoalesceDeleteRemoteResult {
  const deleteItems = input.deleteRemoteItems.filter(
    (item) => item.action.type === "deleteRemote",
  );
  if (deleteItems.length === 0) {
    return {
      folderPaths: [],
      remainingFileItems: [],
      folderToCoveredItems: new Map(),
    };
  }

  const deleteSet = new Set(deleteItems.map((item) => item.pathLower));
  const itemsByPath = new Map(deleteItems.map((item) => [item.pathLower, item]));
  const existingRemote = new Set(
    [...input.existingRemotePathLowers].map((p) => p.toLowerCase()),
  );
  const blocking = new Set(
    [...input.blockingPathLowers].map((p) => p.toLowerCase()),
  );

  // Vacuous "all remotes covered" when existingRemote is empty would pick shallow
  // parents (e.g. Files) and recursively wipe Dropbox — refuse folder coalesce.
  if (existingRemote.size === 0) {
    return {
      folderPaths: [],
      remainingFileItems: deleteItems,
      folderToCoveredItems: new Map(),
    };
  }

  const candidates = collectCandidateFolders(deleteSet);
  type Scored = { folder: string; covered: string[]; depth: number };
  const complete: Scored[] = [];

  for (const folder of candidates) {
    // App-folder / vault root must never be a delete target.
    if (!folder) continue;

    const covered = [...deleteSet].filter((p) => isUnderFolder(p, folder));
    if (covered.length < MIN_FOLDER_COVER_COUNT) continue;

    // Completeness is only as strong as existingRemote. An empty set makes this
    // loop a no-op, so every candidate folder looks "complete" — callers must
    // never pass an emptied snapshot after a richer section already ran.
    let allRemoteCovered = true;
    for (const remotePath of existingRemote) {
      if (isUnderFolder(remotePath, folder) && !deleteSet.has(remotePath)) {
        allRemoteCovered = false;
        break;
      }
    }
    if (!allRemoteCovered) continue;

    let blocked = false;
    for (const blocker of blocking) {
      if (blocker === folder || isUnderFolder(blocker, folder)) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;

    complete.push({
      folder,
      covered,
      depth: folderDepth(folder),
    });
  }

  // Prefer largest cover, then shallower folders (fewer API calls, bigger trees).
  complete.sort((a, b) => {
    if (b.covered.length !== a.covered.length) {
      return b.covered.length - a.covered.length;
    }
    return a.depth - b.depth;
  });

  const folderPaths: string[] = [];
  const folderToCoveredItems = new Map<string, SyncPlanItem[]>();
  const coveredByFolder = new Set<string>();

  for (const scored of complete) {
    // Skip if already covered by a chosen ancestor (or same tree).
    if (
      folderPaths.some(
        (chosen) =>
          scored.folder === chosen
          || isUnderFolder(scored.folder, chosen),
      )
    ) {
      continue;
    }
    // Skip if any covered file was already claimed by a previously chosen folder.
    if (scored.covered.some((p) => coveredByFolder.has(p))) continue;

    const items: SyncPlanItem[] = [];
    for (const pathLower of scored.covered) {
      const item = itemsByPath.get(pathLower);
      if (item) items.push(item);
      coveredByFolder.add(pathLower);
    }
    folderPaths.push(scored.folder);
    folderToCoveredItems.set(scored.folder, items);
  }

  const remainingFileItems = deleteItems.filter(
    (item) => !coveredByFolder.has(item.pathLower),
  );

  return { folderPaths, remainingFileItems, folderToCoveredItems };
}

function collectCandidateFolders(deletePaths: Set<string>): string[] {
  const folders = new Set<string>();
  for (const pathLower of deletePaths) {
    let rest = pathLower;
    while (true) {
      const slash = rest.lastIndexOf("/");
      if (slash <= 0) break;
      rest = rest.slice(0, slash);
      if (rest) folders.add(rest);
    }
  }
  return [...folders];
}

function isUnderFolder(pathLower: string, folder: string): boolean {
  return pathLower.startsWith(`${folder}/`);
}

function folderDepth(folder: string): number {
  if (!folder) return 0;
  return folder.split("/").length;
}
