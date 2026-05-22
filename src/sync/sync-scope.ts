import type { RemoteStorage } from "../adapters/interfaces";
import type { RemoteEntry } from "../types";
import { isExcluded } from "../exclude";

/** 사용자가 선택하는 동기화 범위 */
export type SyncScope = "everything" | "notes" | "settings" | "plugins" | "workspaces";

/** 원격 파일 분류 (모달 카운트용) */
export type VaultSection = "notes" | "settings" | "plugins" | "workspaces";

export interface ScopeCounts {
  notes: number;
  settings: number;
  plugins: number;
  workspaces: number;
  excluded: number;
  totalListed: number;
}

function normalizeConfigDir(configDir: string): string {
  return configDir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** 설정의 exclude 패턴으로 동기화 제외 여부 판단 */
export function isSyncExcluded(path: string, excludePatterns: string[]): boolean {
  const lowered = excludePatterns.map((p) => p.toLowerCase());
  return isExcluded(path, lowered);
}

function isWorkspacePath(path: string, configDir: string): boolean {
  const obs = normalizeConfigDir(configDir);
  const lower = path.toLowerCase();
  const prefix = `${obs}/`;
  if (!lower.startsWith(prefix)) return false;
  const rest = lower.slice(prefix.length);
  if (rest.startsWith("workspaces/")) return true;
  if (rest === "workspaces.json") return true;
  if (rest.startsWith("workspace")) return true;
  return false;
}

function isPluginsPath(path: string, configDir: string): boolean {
  const obs = normalizeConfigDir(configDir);
  const lower = path.toLowerCase();
  return lower.startsWith(`${obs}/plugins/`);
}

function isObsidianPath(path: string, configDir: string): boolean {
  const obs = normalizeConfigDir(configDir);
  const lower = path.toLowerCase();
  return lower === obs || lower.startsWith(`${obs}/`);
}

/**
 * 원격/로컬 경로를 섹션으로 분류 (plugins → workspaces → settings → notes).
 */
export function classifyVaultPath(path: string, configDir: string): VaultSection {
  if (isPluginsPath(path, configDir)) return "plugins";
  if (isWorkspacePath(path, configDir)) return "workspaces";
  if (isObsidianPath(path, configDir)) return "settings";
  return "notes";
}

/** 선택한 scope에 경로가 포함되는지 (exclude 패턴은 scope 밖) */
export function isPathInScope(
  path: string,
  scope: SyncScope,
  configDir: string,
  excludePatterns: string[],
): boolean {
  if (isSyncExcluded(path, excludePatterns)) return false;
  if (scope === "everything") return true;

  const section = classifyVaultPath(path, configDir);
  switch (scope) {
    case "notes":
      return section === "notes";
    case "settings":
      return section === "settings";
    case "plugins":
      return section === "plugins";
    case "workspaces":
      return section === "workspaces";
    default:
      return true;
  }
}

/** 여러 섹션 중 하나에 해당하면 포함 (background multi-select). */
export function isPathInSections(
  path: string,
  sections: VaultSection[],
  configDir: string,
  excludePatterns: string[],
): boolean {
  if (sections.length === 0) return false;
  if (isSyncExcluded(path, excludePatterns)) return false;
  const section = classifyVaultPath(path, configDir);
  return sections.includes(section);
}

export function emptyScopeCounts(): ScopeCounts {
  return {
    notes: 0,
    settings: 0,
    plugins: 0,
    workspaces: 0,
    excluded: 0,
    totalListed: 0,
  };
}

export function countEntry(
  counts: ScopeCounts,
  path: string,
  configDir: string,
  excludePatterns: string[],
): void {
  counts.totalListed++;
  if (isSyncExcluded(path, excludePatterns)) {
    counts.excluded++;
    return;
  }
  const section = classifyVaultPath(path, configDir);
  counts[section]++;
}

/** scope에 해당하는 syncable 파일 수 */
export function countForScope(counts: ScopeCounts, scope: SyncScope): number {
  switch (scope) {
    case "everything":
      return counts.notes + counts.settings + counts.plugins + counts.workspaces;
    case "notes":
      return counts.notes;
    case "settings":
      return counts.settings;
    case "plugins":
      return counts.plugins;
    case "workspaces":
      return counts.workspaces;
  }
}

export interface AssessProgress {
  onProgress?: (counts: ScopeCounts) => void;
  signal?: AbortSignal;
}

/**
 * Dropbox 원격 폴더를 나열해 섹션별 파일 수를 집계한다 (전체 list_folder).
 */
export async function assessRemoteFiles(
  remote: RemoteStorage,
  configDir: string,
  excludePatterns: string[],
  progress?: AssessProgress,
): Promise<ScopeCounts> {
  const counts = emptyScopeCounts();
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    progress?.signal?.throwIfAborted();
    const page = await remote.listChanges(cursor);
    for (const entry of page.entries) {
      if (entry.deleted) continue;
      const path = entry.pathDisplay || entry.pathLower;
      countEntry(counts, path, configDir, excludePatterns);
    }
    progress?.onProgress?.({ ...counts });
    cursor = page.cursor;
    hasMore = page.hasMore;
  }

  return counts;
}

export const SYNC_SCOPE_LABELS: Record<SyncScope, string> = {
  everything: "Everything",
  notes: "Notes & files",
  settings: "Obsidian settings",
  plugins: "Obsidian plugins",
  workspaces: "Obsidian workspaces",
};

/**
 * 명시적 scope(모달 선택)이 없으면 마지막 사용자 선택을 재사용한다.
 * background sync가 매번 "everything"으로 덮어쓰지 않도록 분리.
 */
export function resolveSyncScope(
  explicitScope: SyncScope | undefined,
  lastUsedScope: SyncScope,
): { scope: SyncScope; lastUsedScope: SyncScope } {
  if (explicitScope !== undefined) {
    return { scope: explicitScope, lastUsedScope: explicitScope };
  }
  return { scope: lastUsedScope, lastUsedScope };
}
