import { normalizePath, type DataAdapter } from "obsidian";

export interface DiskListedFile {
  path: string;
  mtime: number;
  size: number;
}

/**
 * Recursively list files under a vault folder using DataAdapter.
 *
 * Obsidian's Vault API does not fully index dot-folders such as `.obsidian`
 * (see obsidian-developer-docs#186). Adapter listing reads what is on disk.
 */
export async function listFilesRecursive(
  adapter: DataAdapter,
  root: string,
  options?: {
    signal?: AbortSignal | null;
    /** Skip descending into these directory prefixes (e.g. ".git/"). */
    skipDirPrefixes?: string[];
  },
): Promise<DiskListedFile[]> {
  const results: DiskListedFile[] = [];
  const normalizedRoot = normalizePath(root);
  const skipPrefixes = (options?.skipDirPrefixes ?? []).map((p) =>
    p.endsWith("/") ? p.toLowerCase() : `${p.toLowerCase()}/`,
  );

  function shouldSkipDir(dirPath: string): boolean {
    const lower = `${dirPath.toLowerCase()}/`;
    return skipPrefixes.some((prefix) => lower.startsWith(prefix) || lower === prefix);
  }

  async function walk(dir: string): Promise<void> {
    options?.signal?.throwIfAborted();
    let listed: { files: string[]; folders: string[] };
    try {
      listed = await adapter.list(dir);
    } catch {
      return;
    }

    for (const name of listed.files) {
      options?.signal?.throwIfAborted();
      const path = dir ? `${dir}/${name}` : name;
      try {
        const st = await adapter.stat(path);
        if (!st) continue;
        results.push({ path, mtime: st.mtime, size: st.size });
      } catch {
        // File disappeared between list and stat (race) — skip.
      }
    }

    for (const folder of listed.folders) {
      const child = dir ? `${dir}/${folder}` : folder;
      if (shouldSkipDir(child)) continue;
      await walk(child);
    }
  }

  if (root === "" || (await adapter.exists(normalizedRoot))) {
    await walk(normalizedRoot);
  }

  return results;
}
