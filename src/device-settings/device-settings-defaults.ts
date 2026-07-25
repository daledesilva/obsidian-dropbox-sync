import type { DeviceSettingsV1 } from "./device-settings-types";

/** Prefixed key so this plugin's blob does not collide with other plugins. */
export const DEVICE_SETTINGS_STORAGE_KEY = "dropbox-sync-device-settings_v1";

export const DEFAULT_CURSOR_DEBUG_PORT = 7662;

/** Fixed bootstrap port for GET /offer (ingest traffic stays on session port). */
export const CURSOR_DEBUG_OFFER_PORT = 7663;

export const DEFAULT_DEVICE_SETTINGS_V1: DeviceSettingsV1 = {
  version: 1,
  cursorDebugHost: "",
  cursorDebugPort: DEFAULT_CURSOR_DEBUG_PORT,
  cursorDebugSessionId: "",
  cursorDebugIngestPath: "",
  cursorDebugServerName: "",
  cursorDebugOfferToken: "",
  cursorDebugConnectedAt: 0,
};
