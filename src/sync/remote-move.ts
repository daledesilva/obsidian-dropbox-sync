import type { RemoteStorage } from "../adapters/interfaces";
import type { RemoteEntry } from "../types";

/** Temp suffix for Dropbox case-only renames — must differ in path_lower from source. */
export const CASE_RENAME_TEMP_SUFFIX = ".__dbxcase__";

export function isCaseOnlyRename(from: string, to: string): boolean {
  return from.toLowerCase() === to.toLowerCase() && from !== to;
}

/**
 * Dropbox does NOT support case-only renaming via a single files/move_v2.
 * Use a two-step server move: path → temp path → desired casing
 * (e.g. note.md → note.md.__dbxcase__ → Note.md).
 */
export async function moveRemotePath(
  remote: RemoteStorage,
  from: string,
  to: string,
): Promise<RemoteEntry> {
  if (isCaseOnlyRename(from, to)) {
    const tempPath = `${from}${CASE_RENAME_TEMP_SUFFIX}`;
    await remote.move(from, tempPath);
    return remote.move(tempPath, to);
  }
  return remote.move(from, to);
}
