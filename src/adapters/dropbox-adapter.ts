import type { HttpClient } from "../http-client";
import type { RemoteStorage } from "./interfaces";
import type {
  RemoteEntry,
  ListChangesResult,
  DownloadResult,
} from "../types";
import { RevConflictError } from "../types";
import type {
  DropboxFileMetadata,
  DropboxMetadata,
  DropboxListFolderResult,
  DropboxErrorResponse,
} from "./dropbox-types";
import { refreshAccessToken } from "./dropbox-auth";
import { delay, runAbortable, throwIfAborted } from "../abort-utils";

const API_BASE = "https://api.dropboxapi.com/2";
const CONTENT_BASE = "https://content.dropboxapi.com/2";

/** HTTP 헤더용 ASCII-safe JSON. 비ASCII 문자를 \uXXXX 이스케이프. */
function headerSafeJson(obj: object): string {
  return JSON.stringify(obj).replace(/[\u0080-\uffff]/g, (c) =>
    "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
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
}

/**
 * Dropbox API v2 직접 호출 어댑터.
 * HttpClient 기반. Obsidian에서는 requestUrl, CLI에서는 fetch를 주입한다.
 */
export class DropboxAdapter implements RemoteStorage {
  private abortSignal: AbortSignal | undefined;

  constructor(private config: DropboxAdapterConfig) {}

  /** 현재 sync cycle의 AbortSignal (HTTP·retry 대기 중단). */
  setAbortSignal(signal: AbortSignal | undefined): void {
    this.abortSignal = signal;
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
      .filter((e): e is DropboxFileMetadata | (DropboxMetadata & { ".tag": "deleted" }) =>
        e[".tag"] === "file" || e[".tag"] === "deleted",
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
  ): Promise<RemoteEntry> {
    const mode = rev
      ? { ".tag": "update" as const, update: rev }
      : { ".tag": "overwrite" as const };

    const apiArg = headerSafeJson({
      path: this.toRemotePath(path),
      mode,
      autorename: false,
      mute: false,
      strict_conflict: true,
    });

    const resp = await this.withRetry({
      url: `${CONTENT_BASE}/files/upload`,
      method: "POST",
      headers: {
        "Dropbox-API-Arg": apiArg,
        "Content-Type": "application/octet-stream",
      },
      body: data.buffer as ArrayBuffer,
      on409: (errBody) => {
        if (errBody.error_summary?.includes("conflict")) {
          throw new RevConflictError(
            `Rev conflict on upload: ${path}`,
            rev ?? "",
          );
        }
      },
    });

    const metadata = resp.json as DropboxFileMetadata;
    return this.fileMetadataToEntry(metadata);
  }

  async delete(path: string): Promise<void> {
    await this.rpcCall("/files/delete_v2", {
      path: this.toRemotePath(path),
    });
  }

  async move(from: string, to: string): Promise<RemoteEntry> {
    const result = await this.rpcCall<{ metadata: DropboxFileMetadata }>(
      "/files/move_v2",
      {
        from_path: this.toRemotePath(from),
        to_path: this.toRemotePath(to),
        autorename: false,
      },
    );
    return this.fileMetadataToEntry(result.metadata);
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
      on429Final: (errBody) => {
        throw new DropboxRateLimitError(
          `Rate limited: ${endpoint}`,
          errBody.error?.retry_after ?? 1,
        );
      },
    });

    return resp.json as T;
  }

  /**
   * 공통 retry 루프: ensureValidToken → httpClient → retryable 판정 → 409/에러 처리.
   */
  private async withRetry(opts: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: string | ArrayBuffer;
    on409?: (errBody: DropboxErrorResponse) => void;
    on429Final?: (errBody: DropboxErrorResponse) => void;
  }): Promise<{ status: number; json: unknown; text: string; headers: Record<string, string>; arrayBuffer: ArrayBuffer }> {
    const maxRetries = 4;
    const signal = this.abortSignal;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      throwIfAborted(signal);
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
        // 네트워크 연결 실패 (iOS -1005 등) — 긴 딜레이로 연결 풀 리셋 유도
        if (attempt < maxRetries) {
          const backoffMs = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s, 16s
          await delay(backoffMs, signal);
          continue;
        }
        throw e;
      }

      // retry 판정 (429 / 5xx)
      if (resp.status === 429 || (resp.status >= 500 && resp.status < 600)) {
        if (attempt < maxRetries) {
          const backoffMs = resp.status === 429
            ? ((resp.json as DropboxErrorResponse | undefined)?.error?.retry_after ?? 1) * 1000
            : 1000 * Math.pow(2, attempt);
          await delay(backoffMs, signal);
          continue;
        }
        if (resp.status === 429 && opts.on429Final) {
          opts.on429Final(resp.json as DropboxErrorResponse);
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
  }

  private refreshPromise: Promise<void> | null = null;

  private async ensureValidToken(): Promise<void> {
    const expiry = this.config.getTokenExpiry();
    if (Date.now() > expiry - 5 * 60 * 1000) {
      if (!this.refreshPromise) {
        this.refreshPromise = this.doRefreshToken();
      }
      try {
        await this.refreshPromise;
      } finally {
        this.refreshPromise = null;
      }
    }
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
    return {
      pathLower: stripped.toLowerCase(),
      pathDisplay: stripped,
      hash: metadata.content_hash ?? null,
      serverModified: new Date(metadata.server_modified).getTime(),
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
