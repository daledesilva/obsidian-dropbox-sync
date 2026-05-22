import type { FileSystem, RemoteStorage, SyncStateStore } from "../adapters/interfaces";

export interface PathRenamePair {
  from: string;
  to: string;
}

/**
 * 로컬·원격·동기화 상태에서 경로 변경을 적용한다.
 * 원격 이동 실패(path 없음)는 무시하고 로컬만 처리한다.
 */
export async function applyPathRenames(
  fs: FileSystem,
  remote: RemoteStorage,
  store: SyncStateStore,
  renames: PathRenamePair[],
): Promise<void> {
  for (const { from, to } of renames) {
    if (from === to) continue;

    try {
      await remote.move(from, to);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("not_found") && !msg.includes("not_found/")) {
        throw e;
      }
    }

    try {
      await fs.rename(from, to);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("not found") && !msg.includes("File not found")) {
        throw e;
      }
    }

    const fromLower = from.toLowerCase();
    const entry = await store.getEntry(fromLower);
    if (entry) {
      await store.setEntry({
        ...entry,
        pathLower: to.toLowerCase(),
        localPath: to,
      });
      await store.deleteEntry(fromLower);
    }
  }
}
