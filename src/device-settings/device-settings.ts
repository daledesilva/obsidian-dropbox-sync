import type { App } from "obsidian";
import {
  DEFAULT_CURSOR_DEBUG_PORT,
  DEFAULT_DEVICE_SETTINGS_V1,
  DEVICE_SETTINGS_STORAGE_KEY,
} from "./device-settings-defaults";
import {
  clearLegacyRawLocalStorage,
  fetchLegacyRawLocalStorage,
  fetchLocally,
  initDeviceSettingsStorage,
  saveLocally,
} from "./device-settings-storage";
import type { DeviceSettingsV1 } from "./device-settings-types";

/**
 * Same-tab App.saveLocalStorage writes do not fire the native `storage` event.
 * Emit this so same-window listeners can refresh without a full reload.
 */
const DEVICE_SETTINGS_CHANGED_EVENT = "dropbox-sync-device-settings-changed";

/**
 * Bind vault-scoped storage. Call once at the start of Plugin.onload so ingest
 * and settings UI never read before App is available. Also copies any legacy
 * raw-localStorage blob into App storage for this vault.
 */
export function initDeviceSettings(app: App): void {
  initDeviceSettingsStorage(app);
  // Prefer App storage; one-time hydrate from the old global key if empty.
  if (fetchLocally(DEVICE_SETTINGS_STORAGE_KEY) != null) return;
  const legacyRaw = fetchLegacyRawLocalStorage(DEVICE_SETTINGS_STORAGE_KEY);
  if (typeof legacyRaw !== "string" || !legacyRaw) return;
  try {
    const migrated = mergeWithDefaults(JSON.parse(legacyRaw) as unknown);
    saveLocally(DEVICE_SETTINGS_STORAGE_KEY, migrated);
  } catch {
    /* corrupt legacy — leave App storage empty; defaults apply on read */
  }
}

function mergeWithDefaults(partial: unknown): DeviceSettingsV1 {
  const base = DEFAULT_DEVICE_SETTINGS_V1;
  if (!partial || typeof partial !== "object") {
    return { ...base };
  }
  const o = partial as Record<string, unknown>;
  const port =
    typeof o.cursorDebugPort === "number" && o.cursorDebugPort > 0 && o.cursorDebugPort < 65536
      ? o.cursorDebugPort
      : DEFAULT_CURSOR_DEBUG_PORT;
  return {
    version: 1,
    cursorDebugHost: typeof o.cursorDebugHost === "string" ? o.cursorDebugHost : base.cursorDebugHost,
    cursorDebugPort: port,
    cursorDebugSessionId:
      typeof o.cursorDebugSessionId === "string" ? o.cursorDebugSessionId : base.cursorDebugSessionId,
    cursorDebugIngestPath:
      typeof o.cursorDebugIngestPath === "string" ? o.cursorDebugIngestPath : base.cursorDebugIngestPath,
  };
}

function coerceStoredValue(stored: unknown): DeviceSettingsV1 {
  // App API stores objects; legacy path / early writes may still be JSON strings.
  if (typeof stored === "string") {
    try {
      return mergeWithDefaults(JSON.parse(stored) as unknown);
    } catch {
      return mergeWithDefaults(null);
    }
  }
  return mergeWithDefaults(stored);
}

/** Read merged device settings (never throws; corrupt storage yields defaults). */
export function readDeviceSettings(): DeviceSettingsV1 {
  const stored = fetchLocally(DEVICE_SETTINGS_STORAGE_KEY);
  if (stored != null) return coerceStoredValue(stored);

  // Fallback if init did not run yet or migration missed a vault.
  const legacyRaw = fetchLegacyRawLocalStorage(DEVICE_SETTINGS_STORAGE_KEY);
  if (typeof legacyRaw === "string" && legacyRaw) {
    try {
      return mergeWithDefaults(JSON.parse(legacyRaw) as unknown);
    } catch {
      return mergeWithDefaults(null);
    }
  }
  return mergeWithDefaults(null);
}

function writeDeviceSettings(settings: DeviceSettingsV1): void {
  const toStore: DeviceSettingsV1 = {
    ...settings,
    version: 1,
  };
  saveLocally(DEVICE_SETTINGS_STORAGE_KEY, toStore);
  // Drop the pre-App-API global key once vault-scoped storage is the source of truth.
  clearLegacyRawLocalStorage(DEVICE_SETTINGS_STORAGE_KEY);
  notifyDeviceSettingsChanged();
}

function notifyDeviceSettingsChanged(): void {
  try {
    window.dispatchEvent(new CustomEvent(DEVICE_SETTINGS_CHANGED_EVENT));
  } catch {
    /* ignore */
  }
}

/** Shallow-merge top-level fields into stored settings and persist. */
export function patchDeviceSettings(partial: Partial<DeviceSettingsV1>): DeviceSettingsV1 {
  const current = readDeviceSettings();
  const next: DeviceSettingsV1 = {
    ...current,
    ...partial,
    version: 1,
  };
  // Re-validate port after merge so UI typos cannot persist an invalid port.
  if (!(next.cursorDebugPort > 0 && next.cursorDebugPort < 65536)) {
    next.cursorDebugPort = DEFAULT_CURSOR_DEBUG_PORT;
  }
  writeDeviceSettings(next);
  return next;
}

export function getCursorDebugHost(): string {
  return readDeviceSettings().cursorDebugHost;
}

export function getCursorDebugPort(): number {
  return readDeviceSettings().cursorDebugPort;
}

export function getCursorDebugSessionId(): string {
  return readDeviceSettings().cursorDebugSessionId;
}

export function getCursorDebugIngestPath(): string {
  return readDeviceSettings().cursorDebugIngestPath;
}

/**
 * Same-tab updates use a custom event; `storage` covers other windows/tabs
 * when Obsidian's localStorage backing store notifies listeners.
 */
export function subscribeDeviceSettingsChanged(onChange: () => void): () => void {
  const wrapped = (): void => {
    onChange();
  };
  window.addEventListener(DEVICE_SETTINGS_CHANGED_EVENT, wrapped);
  window.addEventListener("storage", wrapped);
  return () => {
    window.removeEventListener(DEVICE_SETTINGS_CHANGED_EVENT, wrapped);
    window.removeEventListener("storage", wrapped);
  };
}

export type { DeviceSettingsV1 };
