/**
 * Temporary validation logs for gap-closure phases.
 *
 * Convention (Phase 0.4):
 * - Set `meta.temp` to a phase tag such as `"P1"`, `"P1-a"`, `"P2"`.
 * - Prefer a message that starts with `TEMP` so vault-file greps stay trivial.
 * - Enumerate remaining temp logs with: `rg 'temp:\\s*"P' src/`
 * - Remove a phase's temp logs only after a test run whose output demonstrates
 *   the fix they were added for — never on assumption (editing-guidelines).
 */
import type { CursorDebugLogMeta } from "./cursor-debug-ingest";
import type { SyncMonitorLog } from "./sync-monitor";
import { SyncLogCategories } from "./sync-monitor";

/** Phase tags used while closing sync-scenarios gaps. */
export type SyncTempPhaseTag =
  | "P0"
  | "P1"
  | "P1-a"
  | "P1-b"
  | "P2"
  | "P3"
  | "P4"
  | "P5"
  | "P6";

/**
 * Emit a temporary validation log line. Always prefixes the message with TEMP
 * and stamps meta.temp so phase cleanup can find every call site mechanically.
 */
export function logTemp(
  log: SyncMonitorLog | undefined,
  phase: SyncTempPhaseTag,
  message: string,
  data?: Record<string, unknown>,
  meta?: Omit<CursorDebugLogMeta, "temp">,
): void {
  const body = message.startsWith("TEMP") ? message : `TEMP ${message}`;
  log?.(body, data, {
    ...meta,
    temp: phase,
    category: meta?.category ?? SyncLogCategories.cycle,
    level: meta?.level ?? "debug",
    location: meta?.location ?? "temp-log",
  });
}
