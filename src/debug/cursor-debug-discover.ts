/**
 * Discover Cursor Debug ingest settings from the Mac offer sidecar (:7663).
 *
 * Auto-connect only probes localhost. Connect also tries the cached host and a
 * short private /24 LAN probe so mobile can find the Mac without pasting fields.
 * Cache clears when Debug logging is turned off — not on Obsidian quit.
 *
 * @see docs/cursor-debug-ingest.md
 */
import { Notice, requestUrl } from "obsidian";
import {
  getCursorDebugOfferToken,
  patchDeviceSettings,
  readDeviceSettings,
} from "../device-settings/device-settings";
import {
  CURSOR_DEBUG_OFFER_PORT,
  DEFAULT_CURSOR_DEBUG_PORT,
} from "../device-settings/device-settings-defaults";
import { postCursorDebugIngest } from "./cursor-debug-ingest";

/** Long enough to read as a “logging is on” reminder after connect / plugin reload. */
const CONNECTED_NOTICE_MS = 5000;

export const CURSOR_DEBUG_OFFER_MAGIC_HEADER = "X-Dropbox-Sync-Debug";
export const CURSOR_DEBUG_OFFER_TOKEN_HEADER = "X-Dropbox-Sync-Debug-Token";

export type CursorDebugOffer = {
  serverName: string;
  host: string;
  port: number;
  ingestPath: string;
  sessionId: string;
  token: string;
};

export type DiscoverResult =
  | { ok: true; offer: CursorDebugOffer; via: string }
  | { ok: false; reason: string };

const LOCAL_HOSTS = ["127.0.0.1", "localhost"] as const;
const OFFER_FETCH_TIMEOUT_MS = 900;
const CONNECT_PROBE_BUDGET_MS = 2800;
const CONNECT_PROBE_CONCURRENCY = 12;

function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string {
  if (!headers) return "";
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === want) return String(value);
  }
  return "";
}

/** Reject public hosts — offer GET is LAN/localhost only. */
export function isAllowedOfferHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (!h) return false;
  if (h === "localhost" || h === "127.0.0.1") return true;
  const parts = h.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => Number.parseInt(p, 10));
  if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function parseOfferBody(body: unknown): CursorDebugOffer | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  const serverName = typeof o.serverName === "string" ? o.serverName.trim() : "";
  const host = typeof o.host === "string" ? o.host.trim() : "";
  const ingestPath = typeof o.ingestPath === "string" ? o.ingestPath.trim() : "";
  const sessionId = typeof o.sessionId === "string" ? o.sessionId.trim() : "";
  const token = typeof o.token === "string" ? o.token : "";
  const port =
    typeof o.port === "number"
      ? o.port
      : typeof o.port === "string"
        ? Number.parseInt(o.port, 10)
        : NaN;
  if (!host || !ingestPath || !sessionId) return null;
  if (!(port > 0 && port < 65536)) return null;
  if (!isAllowedOfferHost(host)) return null;
  return {
    serverName,
    host,
    port,
    ingestPath: ingestPath.startsWith("/") ? ingestPath : `/${ingestPath}`,
    sessionId,
    token,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Last fetchOffer reject detail — surfaced on Connect failure Notice + LAN ingest. */
let lastFetchOfferDebug: Record<string, unknown> = {};

/**
 * Discover-path debug lines — only via Cursor Debug ingest (requestUrl + device
 * settings). Never hardcoded fetch/localhost ingest URLs (mobile + relay).
 */
function postDiscoverDebug(
  _host: string,
  hypothesisId: string,
  message: string,
  data: Record<string, unknown>,
  opts?: { sessionId?: string; location?: string },
): void {
  postCursorDebugIngest({
    hypothesisId,
    location: opts?.location ?? "cursor-debug-discover.ts",
    message,
    data: {
      ...data,
      ...(opts?.sessionId ? { preferredSessionId: opts.sessionId } : {}),
    },
  });
}

/** Localhost ingest helper for discover lifecycle (auto-connect / Notice). */
function postLocalDiscoverDebug(
  hypothesisId: string,
  location: string,
  message: string,
  data: Record<string, unknown>,
  _sessionId?: string,
): void {
  postCursorDebugIngest({
    hypothesisId,
    location,
    message,
    data,
  });
}

/**
 * GET http://{host}:7663/offer via requestUrl (not fetch).
 * Requires magic response header and a valid private/localhost offer host field.
 */
export async function fetchOffer(host: string): Promise<CursorDebugOffer | null> {
  const trimmed = host.trim();
  if (!isAllowedOfferHost(trimmed)) {
    lastFetchOfferDebug = { host: trimmed, reject: "host-not-allowed" };
    return null;
  }

  const token = getCursorDebugOfferToken().trim();
  const url = `http://${trimmed}:${CURSOR_DEBUG_OFFER_PORT}/offer`;
  const startedAt = Date.now();

  type RaceOutcome =
    | { kind: "ok"; offer: CursorDebugOffer }
    | { kind: "reject"; reject: string; status?: number; magic?: string; headerKeys?: string[] }
    | { kind: "timeout" };

  const fetchPromise: Promise<RaceOutcome> = requestUrl({
    url,
    method: "GET",
    headers: {
      ...(token ? { [CURSOR_DEBUG_OFFER_TOKEN_HEADER]: token } : {}),
    },
    throw: false,
  }).then((res): RaceOutcome => {
    const magic = headerValue(res.headers, CURSOR_DEBUG_OFFER_MAGIC_HEADER);
    const headerKeys = res.headers ? Object.keys(res.headers).slice(0, 20) : [];
    if (res.status !== 200) {
      return { kind: "reject", reject: "bad-status", status: res.status, magic, headerKeys };
    }
    // H1: mobile requestUrl may omit custom response headers → false reject.
    if (magic !== "1") {
      return { kind: "reject", reject: "magic-header", status: res.status, magic, headerKeys };
    }
    let body: unknown = res.json;
    if (body == null && typeof res.text === "string" && res.text) {
      try {
        body = JSON.parse(res.text) as unknown;
      } catch {
        return { kind: "reject", reject: "json-parse", status: res.status, magic, headerKeys };
      }
    }
    const offer = parseOfferBody(body);
    if (!offer) {
      return { kind: "reject", reject: "body-shape", status: res.status, magic, headerKeys };
    }
    return { kind: "ok", offer };
  }).catch((): RaceOutcome => ({ kind: "reject", reject: "request-throw" }));

  // H2: 900ms race may null-out a slow-but-successful mobile LAN GET.
  const outcome = await Promise.race([
    fetchPromise,
    sleep(OFFER_FETCH_TIMEOUT_MS).then((): RaceOutcome => ({ kind: "timeout" })),
  ]);

  const elapsedMs = Date.now() - startedAt;
  if (outcome.kind === "ok") {
    lastFetchOfferDebug = { host: trimmed, reject: null, elapsedMs };
    postDiscoverDebug(trimmed, "H-fetch", "fetchOffer ok", {
      host: trimmed,
      elapsedMs,
    });
    return outcome.offer;
  }

  lastFetchOfferDebug = {
    host: trimmed,
    elapsedMs,
    ...outcome,
  };
  postDiscoverDebug(trimmed, outcome.kind === "timeout" ? "H-timeout" : "H-fetch", "fetchOffer reject", {
    host: trimmed,
    elapsedMs,
    ...outcome,
  });
  return null;
}

/**
 * User-visible confirmation for Connect / auto-connect.
 * Always shown on a successful join (including same cached offer after reload)
 * so Debug logging being live is hard to miss.
 */
export function notifyCursorDebugConnected(offer: CursorDebugOffer): void {
  const name = offer.serverName.trim();
  const message = name
    ? `A remote computer (${name}) was connected to for debug logging.`
    : "A remote computer was connected to for debug logging.";
  postLocalDiscoverDebug(
    "H-notify",
    "cursor-debug-discover.ts:notifyCursorDebugConnected",
    "showing connect Notice",
    {
      noticeMs: CONNECTED_NOTICE_MS,
      hasServerName: !!name,
      host: offer.host,
      port: offer.port,
      sessionId: offer.sessionId,
    },
    offer.sessionId,
  );
  new Notice(message, CONNECTED_NOTICE_MS);
}

/** Persist offer into device-local settings for ingest POSTs + Connected label. */
export function applyOffer(
  offer: CursorDebugOffer,
  opts?: { notify?: boolean },
): void {
  patchDeviceSettings({
    cursorDebugHost: offer.host,
    cursorDebugPort: offer.port,
    cursorDebugIngestPath: offer.ingestPath,
    cursorDebugSessionId: offer.sessionId,
    cursorDebugServerName: offer.serverName,
    cursorDebugOfferToken: offer.token,
    cursorDebugConnectedAt: Date.now(),
  });
  if (opts?.notify) {
    notifyCursorDebugConnected(offer);
  }
}

/**
 * Clear ingest connection cache. Called when Debug logging is turned off so
 * POSTs do not keep targeting a dead relay after the user ends debugging.
 */
export function clearIngestConnection(): void {
  // Reset ingest fields but keep a valid default port so Advanced stays usable.
  patchDeviceSettings({
    cursorDebugHost: "",
    cursorDebugPort: DEFAULT_CURSOR_DEBUG_PORT,
    cursorDebugSessionId: "",
    cursorDebugIngestPath: "",
    cursorDebugServerName: "",
    cursorDebugOfferToken: "",
    cursorDebugConnectedAt: 0,
  });
}

/** True when device-local fields look like a prior successful Connect. */
export function hasCachedIngestConnection(): boolean {
  const d = readDeviceSettings();
  return (
    d.cursorDebugIngestPath.trim().length > 0
    && d.cursorDebugSessionId.trim().length > 0
    && d.cursorDebugHost.trim().length > 0
  );
}

export function connectedButtonLabel(): string {
  const name = readDeviceSettings().cursorDebugServerName.trim();
  return name ? `Connected to ${name}` : "Connected";
}

/**
 * Best-effort live check: cache present and offer still matches session/path.
 * Settings UI may use hasCachedIngestConnection for a fast label instead.
 */
export async function isConnected(): Promise<boolean> {
  if (!hasCachedIngestConnection()) return false;
  const cached = readDeviceSettings();
  const hosts = [cached.cursorDebugHost.trim(), ...LOCAL_HOSTS].filter(
    (h, i, arr) => h && arr.indexOf(h) === i && isAllowedOfferHost(h),
  );
  for (const host of hosts) {
    const offer = await fetchOffer(host);
    if (
      offer
      && offer.sessionId === cached.cursorDebugSessionId.trim()
      && offer.ingestPath === (
        cached.cursorDebugIngestPath.trim().startsWith("/")
          ? cached.cursorDebugIngestPath.trim()
          : `/${cached.cursorDebugIngestPath.trim()}`
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Auto-connect: localhost only (same computer as Cursor).
 * @param opts.notify default true — set false for silent settings-tab refresh only.
 */
export async function tryAutoConnect(
  opts?: { notify?: boolean },
): Promise<DiscoverResult> {
  const notify = opts?.notify !== false;
  postLocalDiscoverDebug(
    "H-auto",
    "cursor-debug-discover.ts:tryAutoConnect",
    "tryAutoConnect start",
    { notify, hadCache: hasCachedIngestConnection() },
  );
  for (const host of LOCAL_HOSTS) {
    const offer = await fetchOffer(host);
    if (offer) {
      postLocalDiscoverDebug(
        "H-auto",
        "cursor-debug-discover.ts:tryAutoConnect",
        "tryAutoConnect success",
        {
          notify,
          via: host,
          offerHost: offer.host,
          offerPort: offer.port,
          offerSession: offer.sessionId,
        },
        offer.sessionId,
      );
      applyOffer(offer, { notify });
      return { ok: true, offer, via: host };
    }
  }
  postLocalDiscoverDebug(
    "H-auto",
    "cursor-debug-discover.ts:tryAutoConnect",
    "tryAutoConnect failed — no localhost offer",
    { notify },
  );
  return { ok: false, reason: "No offer on localhost" };
}

function subnetHostsFromIp(ip: string): string[] {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return [];
  const [a, b, c] = parts;
  if (!isAllowedOfferHost(`${a}.${b}.${c}.1`)) return [];
  const hosts: string[] = [];
  // Prefer .1 (often gateway) then sweep; skip self.
  for (let d = 1; d <= 254; d++) {
    const h = `${a}.${b}.${c}.${d}`;
    if (h === ip) continue;
    hosts.push(h);
  }
  // Move .1 to front if present.
  hosts.sort((x, y) => {
    const xd = x.endsWith(".1") ? 0 : 1;
    const yd = y.endsWith(".1") ? 0 : 1;
    return xd - yd;
  });
  return hosts;
}

/** Best-effort local IPv4 discovery for Connect-only /24 probe. */
async function discoverLocalIpv4s(): Promise<string[]> {
  const ips = new Set<string>();
  const RTC = (
    globalThis as unknown as {
      RTCPeerConnection?: new (config?: RTCConfiguration) => RTCPeerConnection;
    }
  ).RTCPeerConnection;
  if (!RTC) return [];

  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      try {
        pc.close();
      } catch {
        /* ignore */
      }
      resolve();
    };
    const pc = new RTC({ iceServers: [] });
    try {
      pc.createDataChannel("dropbox-sync-debug-discover");
    } catch {
      done();
      return;
    }
    pc.onicecandidate = (event) => {
      const cand = event.candidate?.candidate;
      if (!cand) {
        done();
        return;
      }
      const match = /([0-9]{1,3}(?:\.[0-9]{1,3}){3})/.exec(cand);
      if (match && isAllowedOfferHost(match[1])) {
        ips.add(match[1]);
      }
    };
    void pc
      .createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch(() => done());
    window.setTimeout(done, 1200);
  });

  return [...ips];
}

async function probeHostsForOffer(
  hosts: string[],
  budgetMs: number,
): Promise<CursorDebugOffer | null> {
  const deadline = Date.now() + budgetMs;
  let found: CursorDebugOffer | null = null;
  let next = 0;

  async function worker(): Promise<void> {
    while (!found && Date.now() < deadline) {
      const index = next++;
      if (index >= hosts.length) return;
      const host = hosts[index];
      if (!isAllowedOfferHost(host)) continue;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      const offer = await fetchOffer(host);
      if (offer) {
        found = offer;
        return;
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(CONNECT_PROBE_CONCURRENCY, hosts.length) },
    () => worker(),
  );
  await Promise.race([Promise.all(workers), sleep(budgetMs)]);
  return found;
}

/**
 * Connect button: localhost → cached host → short private /24 probe.
 * LAN probe is Connect-only (never used by tryAutoConnect).
 */
export async function connect(): Promise<DiscoverResult> {
  for (const host of LOCAL_HOSTS) {
    const offer = await fetchOffer(host);
    if (offer) {
      applyOffer(offer, { notify: true });
      return { ok: true, offer, via: host };
    }
  }

  const cachedHost = readDeviceSettings().cursorDebugHost.trim();
  if (cachedHost && isAllowedOfferHost(cachedHost)) {
    const offer = await fetchOffer(cachedHost);
    if (offer) {
      applyOffer(offer, { notify: true });
      return { ok: true, offer, via: cachedHost };
    }
  }

  const localIps = await discoverLocalIpv4s();
  const probeHosts: string[] = [];
  const seen = new Set<string>();
  for (const ip of localIps) {
    for (const h of subnetHostsFromIp(ip)) {
      if (seen.has(h)) continue;
      seen.add(h);
      probeHosts.push(h);
    }
  }
  // If WebRTC found nothing but we have a cached host, still sweep its /24.
  if (probeHosts.length === 0 && cachedHost && isAllowedOfferHost(cachedHost)) {
    for (const h of subnetHostsFromIp(cachedHost)) {
      if (seen.has(h)) continue;
      seen.add(h);
      probeHosts.push(h);
    }
  }

  if (probeHosts.length > 0) {
    const offer = await probeHostsForOffer(probeHosts, CONNECT_PROBE_BUDGET_MS);
    if (offer) {
      applyOffer(offer, { notify: true });
      return { ok: true, offer, via: `lan:${offer.host}` };
    }
  }

  return {
    ok: false,
    // Include last fetch reject so the Notice itself is runtime evidence on iPad.
    reason: `No debug ingest server found on this network (${JSON.stringify(lastFetchOfferDebug)})`,
  };
}
