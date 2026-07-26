import type { App } from "obsidian";
import { patchDeviceSettings } from "../device-settings/device-settings";
import type { PluginSettings } from "../settings";

/** Written by `bun run qa:open` so sandboxed Obsidian starts ready for Cursor Debug. */
export const QA_DEBUG_BOOTSTRAP_FILENAME = "qa-debug-bootstrap.json";

export type QaDebugBootstrap = {
  /** Turn on Debug logging in plugin settings (synced data.json). */
  debugLoggingEnabled?: boolean;
  /** Device-local planner/decision firehose (trace lines). */
  verboseDecisionLogging?: boolean;
  /** After apply, run tryAutoConnect (default true). */
  autoConnectIngest?: boolean;
};

export type QaDebugBootstrapResult = {
  applied: boolean;
  autoConnect: boolean;
  debugLoggingEnabled: boolean;
  verboseDecisionLogging: boolean;
};

/**
 * Apply optional QA bootstrap from the plugin folder so `qa:open` can pre-enable
 * Debug logging + verbose decision logging without a manual settings pass.
 * File is vault-local and gitignored with other generated plugin state.
 */
export async function applyQaDebugBootstrap(
  app: App,
  settings: PluginSettings,
  saveSettings: () => Promise<void>,
): Promise<QaDebugBootstrapResult> {
  const bootstrapPath =
    `${app.vault.configDir}/plugins/dropbox-sync/${QA_DEBUG_BOOTSTRAP_FILENAME}`;
  const adapter = app.vault.adapter;
  if (!(await adapter.exists(bootstrapPath))) {
    // No QA bootstrap — keep normal onload auto-connect when Debug logging is on.
    return {
      applied: false,
      autoConnect: true,
      debugLoggingEnabled: settings.debugLoggingEnabled,
      verboseDecisionLogging: false,
    };
  }

  let parsed: QaDebugBootstrap = {};
  try {
    parsed = JSON.parse(await adapter.read(bootstrapPath)) as QaDebugBootstrap;
  } catch {
    return {
      applied: false,
      autoConnect: true,
      debugLoggingEnabled: settings.debugLoggingEnabled,
      verboseDecisionLogging: false,
    };
  }

  let settingsDirty = false;
  if (parsed.debugLoggingEnabled === true && !settings.debugLoggingEnabled) {
    settings.debugLoggingEnabled = true;
    settingsDirty = true;
  }
  if (settingsDirty) {
    await saveSettings();
  }

  if (parsed.verboseDecisionLogging === true) {
    // Device-local — must not live only in data.json (see device-settings rules).
    patchDeviceSettings({ verboseDecisionLogging: true });
  }

  return {
    applied: true,
    autoConnect: parsed.autoConnectIngest !== false,
    debugLoggingEnabled: settings.debugLoggingEnabled,
    verboseDecisionLogging: parsed.verboseDecisionLogging === true,
  };
}
