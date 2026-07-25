import {
  DEFAULT_CURSOR_DEBUG_PORT,
  DEFAULT_DEVICE_SETTINGS_V1,
  DEVICE_SETTINGS_STORAGE_KEY,
} from "./device-settings-defaults";
import { fetchLocally, saveLocally } from "./device-settings-storage";
import type { DeviceSettingsV1 } from "./device-settings-types";

/**
 * Same-tab localStorage writes do not fire the native `storage` event.
 * Emit this so same-window listeners can refresh without a full reload.
 */
const DEVICE_SETTINGS_CHANGED_EVENT = "dropbox-sync-device-settings-changed";

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

/** Read merged device settings (never throws; corrupt storage yields defaults). */
export function readDeviceSettings(): DeviceSettingsV1 {
  const raw = fetchLocally(DEVICE_SETTINGS_STORAGE_KEY);
  if (typeof raw !== "string") return mergeWithDefaults(null);
  try {
    return mergeWithDefaults(JSON.parse(raw) as unknown);
  } catch {
    return mergeWithDefaults(null);
  }
}

function writeDeviceSettings(settings: DeviceSettingsV1): void {
  const toStore: DeviceSettingsV1 = {
    ...settings,
    version: 1,
  };
  saveLocally(DEVICE_SETTINGS_STORAGE_KEY, JSON.stringify(toStore));
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
 * for the same vault host.
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
