import type { HttpClient } from "../http-client";
import type {
  RemoteDeleteBatchEntryResult,
  RemoteListedFile,
  RemoteStorage,
} from "./interfaces";
import type {
  RemoteEntry,
  ListChangesResult,
  DownloadResult,
} from "../types";
import { RevConflictError } from "../types";
import type {
  DropboxFileMetadata,
  DropboxFolderMetadata,
  DropboxMetadata,
  DropboxListFolderResult,
  DropboxErrorResponse,
} from "./dropbox-types";
import { refreshAccessToken } from "./dropbox-auth";
import { delay, runAbortable, throwIfAborted } from "../abort-utils";
import { SyncLogCategories, type SyncMonitorLog } from "../debug/sync-monitor";
import { logTemp } from "../debug/temp-log";
import {
  formatClientModifiedIso,
  shouldUseUploadSession,
  splitUploadChunks,
} from "./upload-chunk";

const API_BASE = "https://api.dropboxapi.com/2";
const CONTENT_BASE = "https://content.dropboxapi.com/2";
/** Stone max_items for files/delete_batch entries. */
const DELETE_BATCH_MAX_ENTRIES = 1000;
/** Initial poll interval for delete_batch/check; doubles up to a cap. */
const DELETE_BATCH_POLL_MS = 500;
const DELETE_BATCH_POLL_MAX_MS = 8_000;
/** Max uniform jitter added to 429 waits so concurrent workers don't wake in lockstep. */
const RATE_LIMIT_JITTER_MAX_MS = 250;

export type DropboxRateLimitReason =
  | "too_many_requests"
  | "too_many_write_operations"
  | "unknown";

/**
 * Prefer HTTP Retry-After (Dropbox always sends it), then JSON body retry_after,
 * then 1s. Callers may still apply an exponential floor when write-lock 429s
 * return Retry-After: 0 (literal zero would stampede if only jitter is added).
 */
function resolveRetryAfterSeconds(resp: {
  headers?: Record<string, string>;
  json: unknown;
}): number {
  const headerRaw = resp.headers?.["retry-after"];
  if (headerRaw !== undefined && headerRaw !== "") {
    const fromHeader = Number(headerRaw);
    if (Number.isFinite(fromHeader) && fromHeader >= 0) return fromHeader;
  }
  const body = resp.json as DropboxErrorResponse | undefined;
  const fromBody = body?.error?.retry_after;
  if (typeof fromBody === "number" && Number.isFinite(fromBody) && fromBody >= 0) {
    return fromBody;
  }
  return 1;
}

/** Classify 429 reason for logging / DropboxRateLimitError.reason. */
function parseRateLimitReason(
  errBody: DropboxErrorResponse | undefined,
  text: string,
): DropboxRateLimitReason {
  const tag = errBody?.error?.[".tag"] ?? "";
  const summary = `${errBody?.error_summary ?? ""} ${text}`;
  if (
    tag === "too_many_write_operations"
    || summary.includes("too_many_write_operations")
  ) {
    return "too_many_write_operations";
  }
  if (tag === "too_many_requests" || summary.includes("too_many_requests")) {
    return "too_many_requests";
  }
  return "unknown";
}

type DropboxDeleteBatchLaunch =
  | { ".tag": "complete"; entries: DropboxDeleteBatchResultEntry[] }
  | { ".tag": "async_job_id"; async_job_id: string };

type DropboxDeleteBatchJobStatus =
  | { ".tag": "in_progress" }
  | { ".tag": "complete"; entries: DropboxDeleteBatchResultEntry[] }
  | { ".tag": "failed"; failed?: { ".tag"?: string } };

type DropboxDeleteBatchResultEntry =
  | { ".tag": "success"; metadata?: unknown }
  | {
      ".tag": "failure";
      failure: {
        ".tag"?: string;
        path_lookup?: { ".tag"?: string };
        path_write?: { ".tag"?: string };
      };
    };

/** HTTP 헤더용 ASCII-safe JSON. 비ASCII 문자를 \uXXXX 이스케이프. */
function headerSafeJson(obj: object): string {
  return JSON.stringify(obj).replace(/[\u0080-\uffff]/g, (c) =>
    "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

/** Short path for logs — `/2/files/upload` from a full Dropbox URL. */
function shortDropboxEndpoint(url: string): string {
  const idx = url.indexOf("/2/");
  return idx >= 0 ? url.slice(idx) : url;
}

/**
 * Mutations that contend on Dropbox namespace write locks
 * (`too_many_write_operations` is write-lock pressure, not generic QPS).
 */
function isDropboxWriteEndpoint(url: string): boolean {
  return (
    url.includes("/files/upload")
    || url.includes("/files/upload_session/")
    || url.includes("/files/create_folder")
    || url.includes("/files/delete")
    || url.includes("/files/move")
    || url.includes("/files/copy")
  );
}

export interface DropboxAdapterConfig {
  httpClient: HttpClient;
  appKey: string;
  remotePath: string;
  getAccessToken: () => string;
  getRefreshToken: () => string;
  getTokenExpiry: () => number;
  onTokenRefreshed: (accessToken: string, expiresAt: number) => void;
  /** Structured sync monitor (optional; tests and CLI omit). */
  log?: SyncMonitorLog;
}

/**
 * Dropbox API v2 직접 호출 어댑터.
 * HttpClient 기반. Obsidian에서는 requestUrl, CLI에서는 fetch를 주입한다.
 */
export class DropboxAdapter implements RemoteStorage {
  private abortSignal: AbortSignal | undefined;
  /**
   * Shared cooldown across all concurrent withRetry callers on this instance.
   * One 429 extends the gate so other workers pause instead of stampeding.
   */
  private rateLimitedUntilMs = 0;
  /** In-flight HTTP calls through withRetry (uploads + RPC, including retries). */
  private inFlightHttp = 0;
  private peakInFlightHttp = 0;
  /** Subset of in-flight calls that mutate Dropbox (write-lock pressure). */
  private inFlightWrites = 0;
  private peakInFlightWrites = 0;
  private inFlightCreateFolder = 0;
  private rateLimit429Count = 0;

  constructor(private config: DropboxAdapterConfig) {}

  /** 현재 sync cycle의 AbortSignal (HTTP·retry 대기 중단). */
  setAbortSignal(signal: AbortSignal | undefined): void {
    this.abortSignal = signal;
  }

  /** Remote-call log line; every Dropbox mutation is recorded before it is sent. */
  private log(
    message: string,
    data: Record<string, unknown>,
    location: string,
    level: "trace" | "debug" | "info" | "warn" = "debug",
  ): void {
    this.config.log?.(message, data, {
      category: SyncLogCategories.remote,
      level,
      location,
    });
  }

  async listChanges(cursor?: string): Promise<ListChangesResult> {
    let result: DropboxListFolderResult;

    try {
      if (cursor) {
        result = await this.rpcCall<DropboxListFolderResult>(
          "/files/list_folder/continue",
          { cursor },
        );
      } else {
        result = await this.rpcCall<DropboxListFolderResult>(
          "/files/list_folder",
          {
            path: this.config.remotePath || "",
            recursive: true,
            include_deleted: true,
            limit: 2000,
          },
        );
      }
    } catch (e) {
      // 폴더가 아직 없으면 빈 결과 반환 (첫 동기화 시)
      if (e instanceof Error && e.message.includes("path/not_found")) {
        return { entries: [], cursor: "", hasMore: false };
      }
      throw e;
    }

    const entries = result.entries
      .filter((e): e is DropboxFileMetadata | DropboxFolderMetadata | (DropboxMetadata & { ".tag": "deleted" }) =>
        e[".tag"] === "file" || e[".tag"] === "folder" || e[".tag"] === "deleted",
      )
      .map((e) => this.toRemoteEntry(e));

    return {
      entries,
      cursor: result.cursor,
      hasMore: result.has_more,
    };
  }

  async download(path: string): Promise<DownloadResult> {
    const apiArg = headerSafeJson({ path: this.toRemotePath(path) });

    const resp = await this.withRetry({
      url: `${CONTENT_BASE}/files/download`,
      method: "POST",
      headers: {
        "Dropbox-API-Arg": apiArg,
        "Content-Type": "application/octet-stream",
      },
    });

    const apiResult = resp.headers["dropbox-api-result"];
    if (!apiResult?.trim()) {
      throw new Error(
        "Dropbox download metadata missing (dropbox-api-result header). "
        + `status=${resp.status}, headerKeys=${Object.keys(resp.headers).join(",")}`,
      );
    }

    let metadata: DropboxFileMetadata;
    try {
      metadata = JSON.parse(apiResult) as DropboxFileMetadata;
    } catch {
      throw new Error(
        "Dropbox download metadata invalid (dropbox-api-result is not JSON)",
      );
    }

    if (!metadata.rev || !metadata.path_display) {
      throw new Error(
        "Dropbox download metadata incomplete (missing rev or path_display)",
      );
    }

    return {
      data: new Uint8Array(resp.arrayBuffer),
      metadata: this.fileMetadataToEntry(metadata),
    };
  }

  async upload(
    path: string,
    data: Uint8Array,
    rev?: string,
    clientModified?: number,
  ): Promise<RemoteEntry> {
    const mode = rev
      ? { ".tag": "update" as const, update: rev }
      : { ".tag": "add" as const };

    // G29: rev-less uploads use add (never overwrite) so an unexpected remote file surfaces as conflict.
    this.log("dropbox upload", {
      path,
      bytes: data.length,
      mode: mode[".tag"],
      rev: rev ?? null,
      clientModified: clientModified ?? null,
      session: shouldUseUploadSession(data.length),
    }, "dropbox-adapter.upload");

    if (shouldUseUploadSession(data.length)) {
      return this.uploadViaSession(path, data, mode, clientModified, rev);
    }

    return this.uploadSingleShot(path, data, mode, clientModified, rev);
  }

  /** Single POST /files/upload — files ≤ UPLOAD_SESSION_THRESHOLD_BYTES (G16). */
  private async uploadSingleShot(
    path: string,
    data: Uint8Array,
    mode: { ".tag": "add" } | { ".tag": "update"; update: string },
    clientModified?: number,
    rev?: string,
  ): Promise<RemoteEntry> {
    const clientModifiedIso =
      clientModified !== undefined
        ? formatClientModifiedIso(clientModified)
        : undefined;
    const apiArg = headerSafeJson({
      path: this.toRemotePath(path),
      mode,
      autorename: false,
      mute: false,
      strict_conflict: true,
      ...(clientModifiedIso !== undefined
        ? { client_modified: clientModifiedIso }
        : {}),
    });

    try {
      const resp = await this.withRetry({
        url: `${CONTENT_BASE}/files/upload`,
        method: "POST",
        headers: {
          "Dropbox-API-Arg": apiArg,
          "Content-Type": "application/octet-stream",
        },
        body: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
        on409: (errBody) => {
          const summary = errBody.error_summary ?? "";
          if (summary.includes("conflict") || summary.includes("path/conflict")) {
            throw new RevConflictError(
              `Rev conflict on upload: ${path}`,
              rev ?? "",
            );
          }
        },
      });


      const metadata = resp.json as DropboxFileMetadata;
      return this.fileMetadataToEntry(metadata);
    } catch (e) {
      throw e;
    }
  }

  /**
   * Resumable upload_session for large files (G16).
   * start → append_v2 → finish preserves add/update(rev) commit semantics.
   */
  private async uploadViaSession(
    path: string,
    data: Uint8Array,
    mode: { ".tag": "add" } | { ".tag": "update"; update: string },
    clientModified?: number,
    rev?: string,
  ): Promise<RemoteEntry> {
    const chunks = splitUploadChunks(data);
    logTemp(this.config.log, "P6", "upload_session starting", {
      path,
      bytes: data.length,
      chunks: chunks.length,
      mode: mode[".tag"],
    }, { location: "dropbox-adapter.uploadViaSession" });

    type UploadSessionCursor = { session_id: string; offset: number };

    const startResp = await this.withRetry({
      url: `${CONTENT_BASE}/files/upload_session/start`,
      method: "POST",
      headers: {
        "Dropbox-API-Arg": headerSafeJson({
          close: false,
          session_type: { ".tag": "sequential" },
        }),
        "Content-Type": "application/octet-stream",
      },
      body: chunks[0]!.buffer.slice(
        chunks[0]!.byteOffset,
        chunks[0]!.byteOffset + chunks[0]!.byteLength,
      ) as ArrayBuffer,
    });

    const startBody = startResp.json as { session_id: string };
    if (!startBody?.session_id) {
      throw new Error("Dropbox upload_session/start missing session_id");
    }

    let cursor: UploadSessionCursor = {
      session_id: startBody.session_id,
      offset: chunks[0]!.byteLength,
    };

    for (let index = 1; index < chunks.length; index++) {
      const chunk = chunks[index]!;
      await this.withRetry({
        url: `${CONTENT_BASE}/files/upload_session/append_v2`,
        method: "POST",
        headers: {
          "Dropbox-API-Arg": headerSafeJson({
            cursor,
            close: false,
          }),
          "Content-Type": "application/octet-stream",
        },
        body: chunk.buffer.slice(
          chunk.byteOffset,
          chunk.byteOffset + chunk.byteLength,
        ) as ArrayBuffer,
      });
      cursor = { session_id: cursor.session_id, offset: cursor.offset + chunk.byteLength };
    }

    const finishArg: Record<string, unknown> = {
      cursor,
      commit: {
        path: this.toRemotePath(path),
        mode,
        autorename: false,
        mute: false,
        strict_conflict: true,
        ...(clientModified !== undefined
          ? { client_modified: formatClientModifiedIso(clientModified) }
          : {}),
      },
    };

    const finishResp = await this.withRetry({
      url: `${CONTENT_BASE}/files/upload_session/finish`,
      method: "POST",
      headers: {
        "Dropbox-API-Arg": headerSafeJson(finishArg),
        "Content-Type": "application/octet-stream",
      },
      on409: (errBody) => {
        const summary = errBody.error_summary ?? "";
        if (summary.includes("conflict") || summary.includes("path/conflict")) {
          throw new RevConflictError(
            `Rev conflict on upload: ${path}`,
            rev ?? "",
          );
        }
      },
    });

    const metadata = finishResp.json as DropboxFileMetadata;
    logTemp(this.config.log, "P6", "upload_session finished", {
      path,
      rev: metadata.rev,
      bytes: data.length,
      chunks: chunks.length,
    }, { location: "dropbox-adapter.uploadViaSession" });
    return this.fileMetadataToEntry(metadata);
  }

  async delete(path: string): Promise<void> {
    this.log("dropbox delete", { path }, "dropbox-adapter.delete");
    await this.rpcCall("/files/delete_v2", {
      path: this.toRemotePath(path),
    });
  }

  /**
   * Recursive live list of files under a vault-relative folder.
   * Used before folder delete_batch so unknown Dropbox children block coalesce.
   */
  async listFilePathLowersUnder(folderPath: string): Promise<RemoteListedFile[]> {
    const folder = folderPath.replace(/\/+$/, "");
    if (!folder) return [];

    const listed: RemoteListedFile[] = [];
    let cursor: string | undefined;
    let hasMore = true;

    try {
      while (hasMore) {
        const result = cursor
          ? await this.rpcCall<DropboxListFolderResult>(
            "/files/list_folder/continue",
            { cursor },
          )
          : await this.rpcCall<DropboxListFolderResult>(
            "/files/list_folder",
            {
              path: this.toRemotePath(folder),
              recursive: true,
              include_deleted: false,
              limit: 2000,
            },
          );

        for (const entry of result.entries) {
          if (entry[".tag"] === "file") {
            const stripped = this.stripRemotePrefix(entry.path_lower);
            listed.push({
              pathLower: stripped.toLowerCase(),
              contentHash: entry.content_hash ?? "",
              isFolder: false,
            });
          } else if (entry[".tag"] === "folder") {
            const stripped = this.stripRemotePrefix(entry.path_lower).replace(/\/+$/, "");
            listed.push({
              pathLower: stripped.toLowerCase(),
              contentHash: "",
              isFolder: true,
            });
          }
        }

        hasMore = result.has_more;
        cursor = result.cursor;
      }
    } catch (e) {
      // Missing folder → empty live set (folder delete will be rejected / expanded).
      if (e instanceof Error && e.message.includes("path/not_found")) {
        return [];
      }
      throw e;
    }

    return listed;
  }

  /**
   * Batch-delete files/folders via /files/delete_batch (+ poll check).
   * Folder paths recursively delete contents. path_lookup/not_found is soft-ok
   * (same policy as single deleteRemote). too_many_files is surfaced per entry
   * so the executor can expand a folder back to file paths.
   */
  async deleteBatch(paths: string[]): Promise<RemoteDeleteBatchEntryResult[]> {
    if (paths.length === 0) return [];

    const results: RemoteDeleteBatchEntryResult[] = [];
    for (let offset = 0; offset < paths.length; offset += DELETE_BATCH_MAX_ENTRIES) {
      const chunk = paths.slice(offset, offset + DELETE_BATCH_MAX_ENTRIES);
      const chunkResults = await this.deleteBatchChunk(chunk);
      results.push(...chunkResults);
    }
    return results;
  }

  private async deleteBatchChunk(
    paths: string[],
  ): Promise<RemoteDeleteBatchEntryResult[]> {
    const launch = await this.rpcCall<DropboxDeleteBatchLaunch>(
      "/files/delete_batch",
      {
        entries: paths.map((path) => ({ path: this.toRemotePath(path) })),
      },
    );

    let entries: DropboxDeleteBatchResultEntry[];
    if (launch[".tag"] === "complete") {
      entries = launch.entries;
    } else if (launch[".tag"] === "async_job_id") {
      entries = await this.pollDeleteBatchJob(launch.async_job_id);
    } else {
      throw new Error(
        `Unexpected delete_batch launch: ${JSON.stringify(launch).slice(0, 200)}`,
      );
    }

    if (entries.length !== paths.length) {
      throw new Error(
        `delete_batch result count mismatch: requested ${paths.length}, got ${entries.length}`,
      );
    }

    return paths.map((path, index) =>
      this.mapDeleteBatchEntry(path, entries[index]!),
    );
  }

  private async pollDeleteBatchJob(
    asyncJobId: string,
  ): Promise<DropboxDeleteBatchResultEntry[]> {
    let waitMs = DELETE_BATCH_POLL_MS;
    for (;;) {
      throwIfAborted(this.abortSignal);
      const status = await this.rpcCall<DropboxDeleteBatchJobStatus>(
        "/files/delete_batch/check",
        { async_job_id: asyncJobId },
      );
      if (status[".tag"] === "complete") {
        return status.entries;
      }
      if (status[".tag"] === "failed") {
        const tag = status.failed?.[".tag"] ?? "unknown";
        throw new Error(`Dropbox delete_batch job failed: ${tag}`);
      }
      // in_progress — back off and poll again (no per-item soft timeout).
      await delay(waitMs, this.abortSignal);
      waitMs = Math.min(waitMs * 2, DELETE_BATCH_POLL_MAX_MS);
    }
  }

  private mapDeleteBatchEntry(
    path: string,
    entry: DropboxDeleteBatchResultEntry,
  ): RemoteDeleteBatchEntryResult {
    if (entry[".tag"] === "success") {
      return { path, ok: true };
    }

    const failure = entry.failure;
    const failureTag = failure?.[".tag"] ?? "";
    // Soft-success: remote already gone (stale delete intents).
    if (
      failureTag === "path_lookup"
      && failure.path_lookup?.[".tag"] === "not_found"
    ) {
      return { path, ok: true };
    }
    if (failureTag === "too_many_files") {
      return {
        path,
        ok: false,
        tooManyFiles: true,
        error: new Error(`Dropbox delete_batch too_many_files: ${path}`),
      };
    }
    const summary = JSON.stringify(failure).slice(0, 200);
    return {
      path,
      ok: false,
      error: new Error(`Dropbox delete_batch entry failed: ${summary}`),
    };
  }

  async move(from: string, to: string): Promise<RemoteEntry> {
    // Dropbox does NOT support case-only renaming via a single files/move_v2.
    // Two-step: path → temp path → desired casing (e.g. note.md → note.md.__dbxcase__ → Note.md).
    if (from.toLowerCase() === to.toLowerCase() && from !== to) {
      const tempPath = `${from}.__dbxcase__`;
      await this.moveOnce(from, tempPath);
      return this.moveOnce(tempPath, to);
    }
    return this.moveOnce(from, to);
  }

  async createFolder(path: string): Promise<RemoteEntry> {
    this.log("dropbox create_folder", { path }, "dropbox-adapter.createFolder");
    try {
      const result = await this.rpcCall<{ metadata: DropboxFolderMetadata }>(
        "/files/create_folder_v2",
        {
          path: this.toRemotePath(path),
          autorename: false,
        },
      );
      return this.toRemoteEntry(result.metadata);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Concurrent uploads / sibling creates often materialize the folder first.
      // Rate-limit exhaustion can also leave create_folder failing after uploads
      // already created the path — probe metadata before surfacing a false failure.
      const looksLikeExists =
        message.includes("path/conflict")
        || message.includes("already_exists")
        || message.includes("conflict");
      const isRateLimited =
        e instanceof DropboxRateLimitError
        || message.includes("Rate limited")
        || message.includes("too_many_write_operations");
      if (!looksLikeExists && !isRateLimited) {
        throw e;
      }

      try {
        const meta = await this.rpcCall<DropboxMetadata>("/files/get_metadata", {
          path: this.toRemotePath(path),
          include_deleted: false,
        });
        if (meta[".tag"] === "folder") {
          this.log("dropbox create_folder already present — treating as success", {
            path,
            reason: looksLikeExists ? "conflict" : "rate_limit_exists",
          }, "dropbox-adapter.createFolder");
          return this.toRemoteEntry(meta);
        }
      } catch {
        if (looksLikeExists) {
          // Metadata race on conflict — still report a folder entry so sync can advance.
          this.log("dropbox create_folder conflict without metadata — synthetic ok", {
            path,
          }, "dropbox-adapter.createFolder");
          return {
            pathLower: path.replace(/\\/g, "/").toLowerCase(),
            pathDisplay: path,
            hash: null,
            rev: "",
            serverModified: Date.now(),
            size: 0,
            deleted: false,
            isFolder: true,
          };
        }
      }
      throw e;
    }
  }

  private async moveOnce(from: string, to: string): Promise<RemoteEntry> {
    const result = await this.rpcCall<{ metadata: DropboxFileMetadata | DropboxFolderMetadata }>(
      "/files/move_v2",
      {
        from_path: this.toRemotePath(from),
        to_path: this.toRemotePath(to),
        autorename: false,
      },
    );
    return this.toRemoteEntry(result.metadata);
  }

  /**
   * Durable delete evidence for R6/R10. Paths that never existed return [] (not an
   * error) so first-sync seeds do not spam 409s before the batch upload ask.
   */
  async listRevisions(path: string): Promise<
    Array<{ rev: string; serverModified: number; deleted: boolean; hash: string | null }>
  > {
    let result: import("./dropbox-types").DropboxListRevisionsResult;
    try {
      result = await this.rpcCall<import("./dropbox-types").DropboxListRevisionsResult>(
        "/files/list_revisions",
        {
          path: this.toRemotePath(path),
          mode: { ".tag": "path" },
          limit: 100,
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Never-existed paths are normal on first seed — treat as no revision history.
      if (message.includes("not_found") || message.includes("path/not_found")) {
        this.log("list_revisions", {
          path,
          entryCount: 0,
          isDeleted: false,
          neverExisted: true,
        }, "dropbox-adapter.listRevisions");
        return [];
      }
      throw err;
    }

    const revisions: Array<{
      rev: string;
      serverModified: number;
      deleted: boolean;
      hash: string | null;
    }> = [];

    if (result.is_deleted) {
      revisions.push({
        rev: "deleted",
        serverModified: Date.now(),
        deleted: true,
        hash: null,
      });
    }

    for (const entry of result.entries) {
      revisions.push({
        rev: entry.rev,
        serverModified: new Date(entry.server_modified).getTime(),
        deleted: false,
        hash: entry.content_hash ?? null,
      });
    }

    this.log("list_revisions", {
      path,
      entryCount: result.entries.length,
      isDeleted: result.is_deleted,
    }, "dropbox-adapter.listRevisions");

    return revisions;
  }

  // ── private ──

  private async rpcCall<T>(endpoint: string, body: object): Promise<T> {
    const resp = await this.withRetry({
      url: `${API_BASE}${endpoint}`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      on409: (errBody) => {
        if (errBody.error_summary?.includes("reset")) {
          throw new DropboxCursorResetError("Cursor reset required");
        }
      },
    });

    return resp.json as T;
  }

  /** Abort-aware sleep; tests stub this to avoid real timers. */
  private async sleep(ms: number): Promise<void> {
    await delay(ms, this.abortSignal);
  }

  /** Uniform jitter so concurrent retries don't align; tests may stub to 0. */
  private retryJitterMs(): number {
    return Math.floor(Math.random() * (RATE_LIMIT_JITTER_MAX_MS + 1));
  }

  /** Wait out any shared 429 cooldown before starting an attempt. */
  private async awaitRateLimitGate(): Promise<void> {
    const waitMs = this.rateLimitedUntilMs - Date.now();
    if (waitMs > 0) {
      await this.sleep(waitMs);
    }
  }

  /** Extend the shared gate; overlapping 429s keep the later until-time. */
  private extendRateLimitGate(waitMs: number): void {
    const until = Date.now() + waitMs;
    if (until > this.rateLimitedUntilMs) {
      this.rateLimitedUntilMs = until;
    }
  }

  /**
   * 공통 retry 루프: rate-limit gate → ensureValidToken → httpClient → retryable 판정.
   * 429s honor Retry-After (header then body), add jitter, and pause all workers via
   * the shared gate. Exhausted 429s always throw DropboxRateLimitError (RPC + content).
   */
  private async withRetry(opts: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: string | ArrayBuffer;
    on409?: (errBody: DropboxErrorResponse) => void;
  }): Promise<{ status: number; json: unknown; text: string; headers: Record<string, string>; arrayBuffer: ArrayBuffer }> {
    const maxRetries = 4;
    const signal = this.abortSignal;
    const endpoint = shortDropboxEndpoint(opts.url);
    const isWrite = isDropboxWriteEndpoint(opts.url);
    const isCreateFolder = endpoint.includes("create_folder");
    // Count the whole withRetry lifetime as one in-flight op (retries included).
    this.inFlightHttp++;
    this.peakInFlightHttp = Math.max(this.peakInFlightHttp, this.inFlightHttp);
    if (isWrite) {
      this.inFlightWrites++;
      this.peakInFlightWrites = Math.max(this.peakInFlightWrites, this.inFlightWrites);
    }
    if (isCreateFolder) this.inFlightCreateFolder++;
    let local429s = 0;
    try {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        throwIfAborted(signal);
        // Shared pause: a sibling worker's 429 may have extended the gate.
        await this.awaitRateLimitGate();
        let resp;
        try {
          await this.ensureValidToken();
          resp = await runAbortable(
            this.config.httpClient({
              url: opts.url,
              method: opts.method,
              headers: {
                Authorization: `Bearer ${this.config.getAccessToken()}`,
                ...opts.headers,
              },
              body: opts.body,
            }),
            signal,
          );
        } catch (e) {
          throwIfAborted(signal);
          // Plain-text Dropbox validation errors used to surface as SyntaxError from
          // Obsidian resp.json — never treat parse/API shape errors as network retries.
          if (e instanceof SyntaxError) {
            throw e;
          }
          // 네트워크 연결 실패 (iOS -1005 등) — 긴 딜레이로 연결 풀 리셋 유도
          if (attempt < maxRetries) {
            const backoffMs = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s, 16s
            await this.sleep(backoffMs);
            continue;
          }
          throw e;
        }

        if (resp.status === 429) {
          local429s++;
          this.rateLimit429Count++;
          const retryAfterSec = resolveRetryAfterSeconds(resp);
          const jitterMs = this.retryJitterMs();
          const reason = parseRateLimitReason(
            resp.json as DropboxErrorResponse | undefined,
            resp.text,
          );
          // Write-lock 429s often send Retry-After: 0; ≤250ms jitter stampedes all
          // workers and burns maxRetries in ~1s. Floor to exponential backoff.
          let waitMs = retryAfterSec * 1000 + jitterMs;
          if (
            isWrite
            && reason === "too_many_write_operations"
            && retryAfterSec === 0
          ) {
            waitMs = Math.min(8_000, 1_000 * Math.pow(2, attempt)) + jitterMs;
          }
          this.extendRateLimitGate(waitMs);
          this.log("dropbox 429", {
            endpoint,
            reason,
            attempt,
            retryAfterSec,
            waitMs,
            inFlightWrites: this.inFlightWrites,
            inFlightCreateFolder: this.inFlightCreateFolder,
            peakInFlightWrites: this.peakInFlightWrites,
          }, "dropbox-adapter.withRetry", "warn");
          if (attempt < maxRetries) {
            await this.awaitRateLimitGate();
            continue;
          }
          throw new DropboxRateLimitError(
            `Rate limited (${reason}): ${opts.url}`,
            retryAfterSec,
            reason,
          );
        }

        if (resp.status >= 500 && resp.status < 600) {
          if (attempt < maxRetries) {
            await this.sleep(1000 * Math.pow(2, attempt));
            continue;
          }
          throw this.parseError(resp.status, resp.text);
        }

        // 409 커스텀 핸들링
        if (resp.status === 409 && opts.on409) {
          opts.on409(resp.json as DropboxErrorResponse);
          // on409가 throw하지 않았으면 일반 에러로
          throw this.parseError(resp.status, resp.text);
        }

        if (resp.status !== 200) {
          throw this.parseError(resp.status, resp.text);
        }

        return resp;
      }

      throw new Error("request failed after retries");
    } finally {
      this.inFlightHttp = Math.max(0, this.inFlightHttp - 1);
      if (isWrite) this.inFlightWrites = Math.max(0, this.inFlightWrites - 1);
      if (isCreateFolder) {
        this.inFlightCreateFolder = Math.max(0, this.inFlightCreateFolder - 1);
      }
    }
  }

  private refreshPromise: Promise<void> | null = null;

  private async ensureValidToken(): Promise<void> {
    const expiry = this.config.getTokenExpiry();
    if (Date.now() <= expiry - 5 * 60 * 1000) return;
    // Coalesce concurrent refreshers onto one promise; clear only when it settles
    // so waiters never race a null slot into a second parallel refresh.
    if (!this.refreshPromise) {
      this.refreshPromise = this.doRefreshToken().finally(() => {
        this.refreshPromise = null;
      });
    }
    await this.refreshPromise;
  }

  private async doRefreshToken(): Promise<void> {
    try {
      const result = await refreshAccessToken(
        this.config.httpClient,
        this.config.appKey,
        this.config.getRefreshToken(),
      );
      this.config.onTokenRefreshed(result.accessToken, result.expiresAt);
    } catch (e) {
      throw new DropboxAuthError(
        `Token refresh failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private toRemotePath(localPath: string): string {
    const base = this.config.remotePath || "";
    if (base) {
      return `${base}/${localPath}`;
    }
    return `/${localPath}`;
  }

  /**
   * Dropbox 경로 → vault 상대 경로로 변환.
   * remotePath="/vault" → "/vault/file.md" → "file.md"
   * remotePath="" → "/file.md" → "file.md"
   */
  private stripRemotePrefix(dropboxPath: string): string {
    const base = this.config.remotePath || "";
    let rel = dropboxPath;
    if (base && rel.toLowerCase().startsWith(base.toLowerCase())) {
      rel = rel.slice(base.length);
    }
    // 선행 "/" 제거
    if (rel.startsWith("/")) {
      rel = rel.slice(1);
    }
    return rel;
  }

  private toRemoteEntry(metadata: DropboxMetadata): RemoteEntry {
    if (metadata[".tag"] === "file") {
      return this.fileMetadataToEntry(metadata);
    }
    if (metadata[".tag"] === "folder") {
      const stripped = this.stripRemotePrefix(metadata.path_display);
      return {
        pathLower: stripped.toLowerCase(),
        pathDisplay: stripped,
        hash: null,
        serverModified: 0,
        rev: "",
        size: 0,
        deleted: false,
        isFolder: true,
      };
    }
    // deleted
    const stripped = this.stripRemotePrefix(metadata.path_display);
    return {
      pathLower: stripped.toLowerCase(),
      pathDisplay: stripped,
      hash: null,
      serverModified: 0,
      rev: "",
      size: 0,
      deleted: true,
    };
  }

  private fileMetadataToEntry(metadata: DropboxFileMetadata): RemoteEntry {
    const stripped = this.stripRemotePrefix(metadata.path_display);
    const clientModifiedMs = metadata.client_modified
      ? new Date(metadata.client_modified).getTime()
      : undefined;
    return {
      pathLower: stripped.toLowerCase(),
      pathDisplay: stripped,
      hash: metadata.content_hash ?? null,
      serverModified: new Date(metadata.server_modified).getTime(),
      clientModified: clientModifiedMs,
      rev: metadata.rev,
      size: metadata.size,
      deleted: false,
    };
  }

  private parseError(status: number, text: string): Error {
    if (status === 401) {
      return new DropboxAuthError(`Token expired or revoked: ${text.slice(0, 200)}`);
    }
    return new Error(`Dropbox API error ${status}: ${text.slice(0, 200)}`);
  }
}

export class DropboxRateLimitError extends Error {
  constructor(
    message: string,
    public readonly retryAfter: number,
    public readonly reason: DropboxRateLimitReason = "unknown",
  ) {
    super(message);
    this.name = "DropboxRateLimitError";
  }
}

export class DropboxCursorResetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DropboxCursorResetError";
  }
}

/** 401 토큰 만료/revoke 에러 */
export class DropboxAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DropboxAuthError";
  }
}
