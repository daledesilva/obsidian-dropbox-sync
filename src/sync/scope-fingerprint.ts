import type { VaultSection } from "./sync-scope";

/** Persistent sync scope stored with the Dropbox cursor (G28). */
export interface ScopeFingerprint {
  /** Enabled background-sync sections, sorted. */
  backgroundSections: VaultSection[];
  /** User exclude patterns, sorted lowercase. */
  excludePatterns: string[];
  /** Adapter deep-scan for hidden/dot paths outside .obsidian. */
  includeHidden: boolean;
}

export function computePersistentScopeFingerprint(input: {
  backgroundSections: VaultSection[];
  excludePatterns: string[];
  includeHiddenFilesAndFolders: boolean;
}): ScopeFingerprint {
  return {
    backgroundSections: [...input.backgroundSections].sort(),
    excludePatterns: input.excludePatterns.map((p) => p.toLowerCase()).sort(),
    includeHidden: input.includeHiddenFilesAndFolders,
  };
}

export function serializeScopeFingerprint(fp: ScopeFingerprint): string {
  return JSON.stringify(fp);
}

export function parseScopeFingerprint(raw: string | null): ScopeFingerprint | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ScopeFingerprint;
    if (!Array.isArray(parsed.backgroundSections) || !Array.isArray(parsed.excludePatterns)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * True when the new config exposes paths the old cursor never consumed
 * (section enabled, exclude removed, hidden scan turned on).
 */
export function didScopeWiden(
  previous: ScopeFingerprint | null,
  next: ScopeFingerprint,
): boolean {
  if (!previous) return false;

  if (!previous.includeHidden && next.includeHidden) return true;

  for (const section of next.backgroundSections) {
    if (!previous.backgroundSections.includes(section)) return true;
  }

  for (const pattern of previous.excludePatterns) {
    if (!next.excludePatterns.includes(pattern)) return true;
  }

  return false;
}
