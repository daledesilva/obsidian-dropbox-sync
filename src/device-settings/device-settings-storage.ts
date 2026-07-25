import type { App } from "obsidian";

/**
 * Vault-scoped device storage via Obsidian's App API (eslint-plugin-obsidianmd
 * prefers App#loadLocalStorage / App#saveLocalStorage over window.localStorage).
 * Must call initDeviceSettingsStorage(app) from Plugin.onload before any read/write.
 */
let appRef: App | null = null;

export function initDeviceSettingsStorage(app: App): void {
  appRef = app;
}

/** Read vault-namespaced value; null when unset or storage not initialized. */
export function fetchLocally(key: string): unknown | null {
  if (!appRef) return null;
  try {
    return appRef.loadLocalStorage(key);
  } catch {
    return null;
  }
}

/** Persist vault-namespaced value (pass null to clear). */
export function saveLocally(key: string, value: unknown | null): void {
  if (!appRef) return;
  try {
    appRef.saveLocalStorage(key, value);
  } catch {
    /* quota / private mode — ignore */
  }
}

/**
 * Legacy pre-App-API blob lived in raw window.localStorage (global across vaults).
 * Used only to migrate existing Cursor Debug fields into vault-scoped storage.
 */
export function fetchLegacyRawLocalStorage(key: string): string | null {
  try {
    const active = (window as Window & { activeWindow?: Window }).activeWindow;
    return (active ?? window).localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function clearLegacyRawLocalStorage(key: string): void {
  try {
    const active = (window as Window & { activeWindow?: Window }).activeWindow;
    (active ?? window).localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
