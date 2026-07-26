declare const __DROPBOX_APP_KEY__: string;

export const DEFAULT_APP_KEY: string =
  typeof __DROPBOX_APP_KEY__ !== "undefined" ? __DROPBOX_APP_KEY__ : "";

import type { ConflictStrategy } from "./types";
import type { VaultSection } from "./sync/sync-scope";
import { SYNC_SCOPE_LABELS } from "./sync/sync-scope";
import { getCustomAppKey } from "./device-settings/device-settings";

export const VAULT_EVENT_DEBOUNCE_OPTIONS = [2, 5, 10, 30, 60] as const;
export type VaultEventDebounceSec = (typeof VAULT_EVENT_DEBOUNCE_OPTIONS)[number];

export interface BackgroundSyncSections {
  notes: boolean;
  settings: boolean;
  plugins: boolean;
  workspaces: boolean;
}

export const DEFAULT_BACKGROUND_SYNC_SECTIONS: BackgroundSyncSections = {
  notes: true,
  settings: false,
  plugins: false,
  workspaces: false,
};

export interface PluginSettings {
  appKey: string;
  useCustomAppKey: boolean;
  syncInterval: number;
  /** Interval, longpoll, and file-watch triggers. Manual “Sync now” works when false. */
  backgroundSyncEnabled: boolean;
  /** Sections included in automatic background sync cycles. */
  backgroundSyncSections: BackgroundSyncSections;
  /** Debounce before syncing after vault file change events (seconds). */
  vaultEventDebounceSec: VaultEventDebounceSec;
  /**
   * When a background sync plans more than this many actions, show progress UI
   * and allow cancel like a manual Sync now (default 10 → promote when > 10).
   */
  largeSyncInteractiveThreshold: number;
  conflictStrategy: ConflictStrategy;
  deleteProtection: boolean;
  deleteThreshold: number;
  syncName: string;
  excludePatterns: string[];
  /**
   * Stable per-vault id for IndexedDB sync-state naming. Must not use
   * vault.getName() — folder basenames collide across vaults on one machine.
   */
  vaultInstanceId: string;
  syncOnCreateDeleteRename: boolean;
  /** Deep-scan dotfolders via adapter (whole vault). Off by default; slower. */
  includeHiddenFilesAndFolders: boolean;
  /**
   * When false, log() is a no-op (no vault file, console, or Cursor Wi‑Fi ingest).
   * Default true preserves existing troubleshooting / View logs behavior.
   */
  debugLoggingEnabled: boolean;
  onboardingDone: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  appKey: "",
  useCustomAppKey: false,
  syncInterval: 60,
  backgroundSyncEnabled: false,
  backgroundSyncSections: { ...DEFAULT_BACKGROUND_SYNC_SECTIONS },
  vaultEventDebounceSec: 2,
  largeSyncInteractiveThreshold: 10,
  conflictStrategy: "keep_both",
  deleteProtection: true,
  deleteThreshold: 5,
  syncName: "",
  excludePatterns: [],
  vaultInstanceId: "",
  syncOnCreateDeleteRename: true,
  includeHiddenFilesAndFolders: false,
  debugLoggingEnabled: true,
  onboardingDone: false,
};

/**
 * 플러그인이 권장하는 기본 제외 패턴 (설정 UI에 표시·편집 가능).
 * 숨김 제외 없음 — 여기에 없으면 동기화 대상이 될 수 있음.
 */
export function getBuiltInExcludePatterns(configDir: string): string[] {
  return [
    ".git/",
    ".trash/",
    ".sync-state/",
    // Device debug log + per-sync reports stay local (C8); they are vault clutter
    // and must not travel when Notes & files is enabled.
    "sync-debug-*.log",
    "sync-logs/",
    ".DS_Store",
    "Thumbs.db",
    `${configDir}/workspace*`,
    // OAuth tokens must not sync via Plugins section (G25).
    `${configDir}/plugins/dropbox-sync/data.json`,
  ];
}

/** 최초 설정용 — built-in 목록과 동일 */
export function getDefaultExcludePatterns(configDir: string): string[] {
  return [...getBuiltInExcludePatterns(configDir)];
}

/** 기존 설정에 누락된 built-in 패턴을追加 (업그레이드 시 UI에 보이도록) */
export function mergeBuiltInExcludePatterns(
  existing: string[],
  configDir: string,
): string[] {
  const seen = new Set(existing.map((p) => p.toLowerCase()));
  const merged = [...existing];
  for (const pattern of getBuiltInExcludePatterns(configDir)) {
    const key = pattern.toLowerCase();
    if (!seen.has(key)) {
      merged.push(pattern);
      seen.add(key);
    }
  }
  return merged;
}

export function snapVaultEventDebounceSec(value: number): VaultEventDebounceSec {
  let best: VaultEventDebounceSec = VAULT_EVENT_DEBOUNCE_OPTIONS[0];
  let bestDist = Math.abs(value - best);
  for (const opt of VAULT_EVENT_DEBOUNCE_OPTIONS) {
    const dist = Math.abs(value - opt);
    if (dist < bestDist) {
      best = opt;
      bestDist = dist;
    }
  }
  return best;
}

export function debounceSecToSliderIndex(sec: VaultEventDebounceSec): number {
  const idx = VAULT_EVENT_DEBOUNCE_OPTIONS.indexOf(sec);
  return idx >= 0 ? idx : 0;
}

export function getEnabledBackgroundSections(settings: PluginSettings): VaultSection[] {
  return sectionsFromToggles(settings.backgroundSyncSections ?? DEFAULT_BACKGROUND_SYNC_SECTIONS, {
    fallbackToNotes: true,
  });
}

/** Manual sync modal defaults: off for background-synced sections and workspaces. */
export function getManualSyncToggleDefaults(settings: PluginSettings): BackgroundSyncSections {
  const auto = settings.backgroundSyncEnabled;
  const bg = settings.backgroundSyncSections ?? DEFAULT_BACKGROUND_SYNC_SECTIONS;
  return {
    notes: !(auto && bg.notes),
    settings: !(auto && bg.settings),
    plugins: !(auto && bg.plugins),
    workspaces: false,
  };
}

export function sectionsFromToggles(
  toggles: BackgroundSyncSections,
  options?: { fallbackToNotes?: boolean },
): VaultSection[] {
  const sections: VaultSection[] = [];
  if (toggles.notes) sections.push("notes");
  if (toggles.settings) sections.push("settings");
  if (toggles.plugins) sections.push("plugins");
  if (toggles.workspaces) sections.push("workspaces");
  if (sections.length > 0) return sections;
  return options?.fallbackToNotes ? ["notes"] : [];
}

const SECTION_LABELS: Record<VaultSection, string> = {
  notes: SYNC_SCOPE_LABELS.notes,
  settings: SYNC_SCOPE_LABELS.settings,
  plugins: SYNC_SCOPE_LABELS.plugins,
  workspaces: SYNC_SCOPE_LABELS.workspaces,
};

export function formatBackgroundSectionsLabel(sections: VaultSection[]): string {
  if (sections.length === 0) return SECTION_LABELS.notes;
  return sections.map((s) => SECTION_LABELS[s]).join(", ");
}

export function countEnabledBackgroundSections(sections: BackgroundSyncSections): number {
  return (["notes", "settings", "plugins", "workspaces"] as const).filter((k) => sections[k]).length;
}

export function migrateSettings(
  raw: Partial<PluginSettings> | null | undefined,
): Partial<PluginSettings> {
  const migrated = { ...(raw ?? {}) };
  if (!migrated.backgroundSyncSections) {
    migrated.backgroundSyncSections = { ...DEFAULT_BACKGROUND_SYNC_SECTIONS };
  }
  if (
    migrated.vaultEventDebounceSec === undefined
    || !VAULT_EVENT_DEBOUNCE_OPTIONS.includes(migrated.vaultEventDebounceSec as VaultEventDebounceSec)
  ) {
    migrated.vaultEventDebounceSec = snapVaultEventDebounceSec(
      typeof migrated.vaultEventDebounceSec === "number" ? migrated.vaultEventDebounceSec : 2,
    );
  }
  if (migrated.includeHiddenFilesAndFolders === undefined) {
    migrated.includeHiddenFilesAndFolders = false;
  }
  // Pre-toggle installs always wrote sync-debug logs; default on so View logs stays useful.
  if (migrated.debugLoggingEnabled === undefined) {
    migrated.debugLoggingEnabled = true;
  }
  if (
    migrated.largeSyncInteractiveThreshold === undefined
    || typeof migrated.largeSyncInteractiveThreshold !== "number"
    || migrated.largeSyncInteractiveThreshold < 1
  ) {
    migrated.largeSyncInteractiveThreshold = 10;
  }
  if ((migrated as { conflictStrategy?: string }).conflictStrategy === "newest") {
    migrated.conflictStrategy = "keep_both";
  }
  return migrated;
}

export { generateDeviceId } from "./device-settings/device-settings-defaults";

export function generateVaultInstanceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback when randomUUID is unavailable (older runtimes).
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 유효한 App Key 결정: custom key > 빌트인 key > 기존 settings (하위 호환).
 */
/** 허용: 영문, 숫자, 하이픈, 언더스코어. 1~100자. */
const VALID_SYNC_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;

export function isValidSyncName(name: string): boolean {
  return VALID_SYNC_NAME.test(name);
}

/** @deprecated 유효성 검사(isValidSyncName)를 대신 사용 */
export function sanitizeSyncName(raw: string): string {
  return raw.replace(/[/\\:*?"<>|]/g, "").replace(/^[\s.]+|[\s.]+$/g, "").slice(0, 100);
}

export function getEffectiveRemotePath(settings: PluginSettings): string {
  return "/" + settings.syncName;
}

export function getEffectiveAppKey(settings: PluginSettings): string {
  if (settings.useCustomAppKey) {
    const deviceKey = getCustomAppKey();
    if (deviceKey) return deviceKey;
    if (settings.appKey) return settings.appKey;
  }
  return DEFAULT_APP_KEY || settings.appKey;
}
