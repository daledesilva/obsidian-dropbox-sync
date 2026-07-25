/**
 * Device-local blob stored via App.loadLocalStorage / App.saveLocalStorage
 * (vault-namespaced on this machine; not synced via plugin data.json).
 * Cursor ingest host/session must stay per-machine so a Mac LAN IP does not
 * sync into other devices' vault settings.
 */
export interface DeviceSettingsV1 {
  /** Schema version for future migrations. */
  version: 1;
  /** Mac LAN IP (or hostname) reachable from this device over Wi‑Fi. */
  cursorDebugHost: string;
  /** Cursor Debug ingest port (Cursor binds localhost; LAN relay exposes this). */
  cursorDebugPort: number;
  /** Short session slug from Cursor Debug (also used in X-Debug-Session-Id). */
  cursorDebugSessionId: string;
  /** Ingest path from Cursor Debug, e.g. `/ingest/<uuid>`. */
  cursorDebugIngestPath: string;
}
