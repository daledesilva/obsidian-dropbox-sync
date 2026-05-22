declare const __DROPBOX_APP_KEY__: string;

export const DEFAULT_APP_KEY: string =
  typeof __DROPBOX_APP_KEY__ !== "undefined" ? __DROPBOX_APP_KEY__ : "";

import type { ConflictStrategy } from "./types";

export interface PluginSettings {
  appKey: string;
  useCustomAppKey: boolean;
  refreshToken: string;
  accessToken: string;
  tokenExpiry: number;
  syncInterval: number;
  /** Interval, longpoll, and file-watch triggers. Manual “Sync now” works when false. */
  backgroundSyncEnabled: boolean;
  conflictStrategy: ConflictStrategy;
  deleteProtection: boolean;
  deleteThreshold: number;
  syncName: string;
  excludePatterns: string[];
  deviceId: string;
  syncOnCreateDeleteRename: boolean;
  onboardingDone: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  appKey: "",
  useCustomAppKey: false,
  refreshToken: "",
  accessToken: "",
  tokenExpiry: 0,
  syncInterval: 60,
  backgroundSyncEnabled: false,
  conflictStrategy: "keep_both",
  deleteProtection: true,
  deleteThreshold: 5,
  syncName: "",
  excludePatterns: [],
  deviceId: "",
  syncOnCreateDeleteRename: false,
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
    ".sync-reports/",
    "_sync-log.md",
    "sync-debug-*.log",
    ".DS_Store",
    "Thumbs.db",
    `${configDir}/workspace*`,
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

export function generateDeviceId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 4; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
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
  if (settings.useCustomAppKey && settings.appKey) {
    return settings.appKey;
  }
  return DEFAULT_APP_KEY || settings.appKey;
}
