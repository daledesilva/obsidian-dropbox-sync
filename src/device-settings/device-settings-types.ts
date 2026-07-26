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
  /** Friendly Mac name from the discovery offer (Connect / Connected label). */
  cursorDebugServerName: string;
  /** Offer token echoed as X-Dropbox-Sync-Debug-Token on later GET /offer. */
  cursorDebugOfferToken: string;
  /** Epoch ms when Connect / auto-connect last applied an offer (0 = never). */
  cursorDebugConnectedAt: number;
  /**
   * Promote `trace` log lines (the per-path planner decision firehose) to
   * written output. Device-local because a 20k-file vault emits one line per
   * file per cycle, which is right for diagnosing one machine and wrong as a
   * default everywhere.
   */
  verboseDecisionLogging: boolean;
  /** Per-machine identity for conflict copy naming and debug logs (G26). */
  deviceId: string;
  /** Dropbox OAuth — must not live in synced data.json (G25). */
  accessToken: string;
  refreshToken: string;
  tokenExpiry: number;
  /** Custom Dropbox app key when useCustomAppKey is enabled on synced settings. */
  customAppKey: string;
}
