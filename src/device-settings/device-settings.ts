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
  isDeviceSettingsStorageBound,
  saveLocally,
} from "./device-settings-storage";
import type { DeviceSettingsV1 } from "./device-settings-types";
import { generateDeviceId } from "./device-settings-defaults";

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
  const connectedAt =
    typeof o.cursorDebugConnectedAt === "number" && o.cursorDebugConnectedAt >= 0
      ? o.cursorDebugConnectedAt
      : base.cursorDebugConnectedAt;
  return {
    version: 1,
    cursorDebugHost: typeof o.cursorDebugHost === "string" ? o.cursorDebugHost : base.cursorDebugHost,
    cursorDebugPort: port,
    cursorDebugSessionId:
      typeof o.cursorDebugSessionId === "string" ? o.cursorDebugSessionId : base.cursorDebugSessionId,
    cursorDebugIngestPath:
      typeof o.cursorDebugIngestPath === "string" ? o.cursorDebugIngestPath : base.cursorDebugIngestPath,
    cursorDebugServerName:
      typeof o.cursorDebugServerName === "string" ? o.cursorDebugServerName : base.cursorDebugServerName,
    cursorDebugOfferToken:
      typeof o.cursorDebugOfferToken === "string" ? o.cursorDebugOfferToken : base.cursorDebugOfferToken,
    cursorDebugConnectedAt: connectedAt,
    verboseDecisionLogging:
      typeof o.verboseDecisionLogging === "boolean"
        ? o.verboseDecisionLogging
        : base.verboseDecisionLogging,
    deviceId: typeof o.deviceId === "string" ? o.deviceId : base.deviceId,
    accessToken: typeof o.accessToken === "string" ? o.accessToken : base.accessToken,
    refreshToken: typeof o.refreshToken === "string" ? o.refreshToken : base.refreshToken,
    tokenExpiry:
      typeof o.tokenExpiry === "number" && o.tokenExpiry >= 0
        ? o.tokenExpiry
        : base.tokenExpiry,
    customAppKey: typeof o.customAppKey === "string" ? o.customAppKey : base.customAppKey,
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

let memoryOnlySettings: DeviceSettingsV1 | null = null;

/** Read merged device settings (never throws; corrupt storage yields defaults). */
export function readDeviceSettings(): DeviceSettingsV1 {
  const stored = fetchLocally(DEVICE_SETTINGS_STORAGE_KEY);
  if (stored != null) return coerceStoredValue(stored);
  if (memoryOnlySettings) return memoryOnlySettings;

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
  if (!isDeviceSettingsStorageBound()) {
    memoryOnlySettings = toStore;
    notifyDeviceSettingsChanged();
    return;
  }
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

export function getCursorDebugServerName(): string {
  return readDeviceSettings().cursorDebugServerName;
}

export function getCursorDebugOfferToken(): string {
  return readDeviceSettings().cursorDebugOfferToken;
}

export function getVerboseDecisionLogging(): boolean {
  return readDeviceSettings().verboseDecisionLogging;
}

/** Mint deviceId on first read if absent (G26). */
export function getDeviceId(): string {
  const current = readDeviceSettings();
  if (current.deviceId) return current.deviceId;
  const deviceId = generateDeviceId();
  patchDeviceSettings({ deviceId });
  return deviceId;
}

export function getAccessToken(): string {
  return readDeviceSettings().accessToken;
}

export function getRefreshToken(): string {
  return readDeviceSettings().refreshToken;
}

export function getTokenExpiry(): number {
  return readDeviceSettings().tokenExpiry;
}

export function getCustomAppKey(): string {
  return readDeviceSettings().customAppKey;
}

export function setOAuthTokens(accessToken: string, refreshToken: string, tokenExpiry: number): void {
  patchDeviceSettings({ accessToken, refreshToken, tokenExpiry });
}

export function patchOAuthTokens(partial: {
  accessToken?: string;
  refreshToken?: string;
  tokenExpiry?: number;
}): void {
  patchDeviceSettings(partial);
}

export function clearOAuthTokens(): void {
  patchDeviceSettings({ accessToken: "", refreshToken: "", tokenExpiry: 0 });
}

export function setCustomAppKey(customAppKey: string): void {
  patchDeviceSettings({ customAppKey });
}

/**
 * One-time migration from synced plugin data.json into device-local storage (G25/G26).
 * Returns true when any credential field was copied from synced settings.
 */
export function migrateDeviceCredentialsFromSyncedSettings(
  raw: Record<string, unknown> | null | undefined,
): boolean {
  if (!raw || typeof raw !== "object") return false;

  const current = readDeviceSettings();
  const patch: Partial<DeviceSettingsV1> = {};
  let migrated = false;

  if (!current.deviceId && typeof raw.deviceId === "string" && raw.deviceId) {
    patch.deviceId = raw.deviceId;
    migrated = true;
  }
  if (!current.accessToken && typeof raw.accessToken === "string" && raw.accessToken) {
    patch.accessToken = raw.accessToken;
    migrated = true;
  }
  if (!current.refreshToken && typeof raw.refreshToken === "string" && raw.refreshToken) {
    patch.refreshToken = raw.refreshToken;
    migrated = true;
  }
  if (
    !current.tokenExpiry
    && typeof raw.tokenExpiry === "number"
    && raw.tokenExpiry > 0
  ) {
    patch.tokenExpiry = raw.tokenExpiry;
    migrated = true;
  }
  if (
    !current.customAppKey
    && typeof raw.appKey === "string"
    && raw.appKey
    && raw.useCustomAppKey === true
  ) {
    patch.customAppKey = raw.appKey;
    migrated = true;
  }

  if (migrated) {
    patchDeviceSettings(patch);
  }
  return migrated;
}

/** Strip credential fields from synced settings before persisting data.json. */
export function stripSyncedCredentialFields(
  settings: Record<string, unknown>,
): void {
  delete settings.deviceId;
  delete settings.accessToken;
  delete settings.refreshToken;
  delete settings.tokenExpiry;
  if (settings.useCustomAppKey === true) {
    settings.appKey = "";
  }
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
