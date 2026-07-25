/**
 * Structured NDJSON ingest for Cursor Debug sessions.
 *
 * Prefer this over ad-hoc fetch or console-only logging when a Cursor Debug
 * agent needs runtime evidence from desktop or mobile. Obsidian mobile must use
 * requestUrl (not fetch). Target host/path come from device-local settings so
 * Mac LAN IPs do not sync via vault data.json.
 *
 * @see docs/cursor-debug-ingest.md
 */
import { Platform, requestUrl } from "obsidian";
import {
  getCursorDebugHost,
  getCursorDebugIngestPath,
  getCursorDebugPort,
  getCursorDebugSessionId,
} from "../device-settings/device-settings";

export type CursorDebugIngestEntry = {
  hypothesisId: string;
  location: string;
  message: string;
  data?: Record<string, unknown>;
  runId?: string;
};

/** Optional tags so vault log + Wi‑Fi ingest share the same filterable metadata. */
export type CursorDebugLogMeta = {
  hypothesisId?: string;
  location?: string;
  runId?: string;
};

function normalizeIngestPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * Build the full ingest URL from device-local settings.
 * Desktop may omit host and use 127.0.0.1; mobile requires an explicit host
 * (usually the Mac LAN IP behind scripts/ingest-lan-relay.sh).
 */
export function resolveCursorDebugIngestUrl(): string | null {
  const ingestPath = normalizeIngestPath(getCursorDebugIngestPath());
  if (!ingestPath) return null;

  const port = getCursorDebugPort();
  let host = getCursorDebugHost().trim();
  if (!host) {
    if (Platform.isMobile) return null;
    host = "127.0.0.1";
  }

  return `http://${host}:${port}${ingestPath}`;
}

/**
 * True when a deliverable ingest URL exists, or a session id is set (UI hint).
 * Actual POSTs still require resolveCursorDebugIngestUrl() — session id alone is not enough.
 */
export function isCursorDebugIngestConfigured(): boolean {
  return getCursorDebugSessionId().trim().length > 0 || resolveCursorDebugIngestUrl() !== null;
}

/**
 * POST one NDJSON line to the Cursor Debug ingest endpoint when configured.
 * Best-effort: network failures are swallowed so sync never fails on logging.
 */
export function postCursorDebugIngest(entry: CursorDebugIngestEntry): void {
  const sessionId = getCursorDebugSessionId().trim();
  const ingestUrl = resolveCursorDebugIngestUrl();
  // Need at least a URL to deliver; session id alone cannot reach Cursor.
  if (!ingestUrl) return;

  const payload = {
    ...(sessionId ? { sessionId } : {}),
    ...entry,
    timestamp: Date.now(),
  };
  const line = JSON.stringify(payload);

  void requestUrl({
    url: ingestUrl,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sessionId ? { "X-Debug-Session-Id": sessionId } : {}),
    },
    body: line,
    throw: false,
  }).catch(() => {});
}

/**
 * Map ordinary plugin log lines into Cursor Debug ingest entries.
 * Default hypothesisId "log" marks continuous logging; callers may override
 * via meta (e.g. sync monitor tags: sync, H-A, H-B).
 */
export function postCursorDebugLogLine(
  message: string,
  data?: unknown,
  meta?: CursorDebugLogMeta,
): void {
  if (!isCursorDebugIngestConfigured()) return;

  let dataRecord: Record<string, unknown> | undefined;
  if (data instanceof Error) {
    dataRecord = {
      name: data.name,
      message: data.message,
      ...(data.stack ? { stack: data.stack } : {}),
    };
  } else if (data !== undefined) {
    if (data !== null && typeof data === "object" && !Array.isArray(data)) {
      dataRecord = data as Record<string, unknown>;
    } else {
      dataRecord = { value: data };
    }
  }

  postCursorDebugIngest({
    hypothesisId: meta?.hypothesisId ?? "log",
    location: meta?.location ?? "main.log",
    message,
    ...(meta?.runId ? { runId: meta.runId } : {}),
    ...(dataRecord ? { data: dataRecord } : {}),
  });
}
