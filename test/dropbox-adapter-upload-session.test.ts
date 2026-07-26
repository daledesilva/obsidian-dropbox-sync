import { describe, test, expect, mock, beforeEach } from "bun:test";
import { DropboxAdapter } from "@/adapters/dropbox-adapter";
import type { HttpClient } from "@/http-client";
import { UPLOAD_SESSION_THRESHOLD_BYTES } from "@/adapters/upload-chunk";

const httpClientMock = mock() as unknown as ReturnType<typeof mock> & HttpClient;

function createAdapter(): DropboxAdapter {
  const adapter = new DropboxAdapter({
    httpClient: (...args: unknown[]) => (httpClientMock as any)(...args),
    appKey: "test-key",
    remotePath: "",
    getAccessToken: () => "test-token",
    getRefreshToken: () => "test-refresh",
    getTokenExpiry: () => Date.now() + 3600_000,
    onTokenRefreshed: () => {},
  });
  (adapter as any).sleep = () => Promise.resolve();
  (adapter as any).retryJitterMs = () => 0;
  return adapter;
}

describe("DropboxAdapter upload_session (G16)", () => {
  beforeEach(() => {
    httpClientMock.mockReset();
  });

  test("large upload uses start + append + finish with client_modified", async () => {
    const adapter = createAdapter();
    const data = new Uint8Array(UPLOAD_SESSION_THRESHOLD_BYTES + 1);
    data.fill(7);
    const mtime = Date.UTC(2026, 0, 15, 12, 0, 0);

    httpClientMock.mockResolvedValueOnce({
      status: 200,
      json: { session_id: "sess_1" },
      text: "{}",
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
    });
    httpClientMock.mockResolvedValueOnce({
      status: 200,
      json: {},
      text: "{}",
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
    });
    httpClientMock.mockResolvedValueOnce({
      status: 200,
      json: {
        ".tag": "file",
        name: "large.bin",
        path_lower: "/large.bin",
        path_display: "/large.bin",
        id: "id:large",
        client_modified: "2026-01-15T12:00:00.000Z",
        server_modified: "2026-01-15T12:00:01.000Z",
        rev: "rev_large",
        size: data.length,
        content_hash: "abc",
      },
      text: "{}",
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
    });

    const entry = await adapter.upload("large.bin", data, undefined, mtime);
    expect(entry.rev).toBe("rev_large");
    expect(entry.clientModified).toBe(mtime);

    expect(httpClientMock).toHaveBeenCalledTimes(3);
    const startCall = httpClientMock.mock.calls[0]![0] as { url: string; headers?: Record<string, string> };
    const appendCall = httpClientMock.mock.calls[1]![0] as { url: string };
    const finishCall = httpClientMock.mock.calls[2]![0] as { url: string; headers?: Record<string, string> };
    expect(startCall.url).toContain("/files/upload_session/start");
    expect(appendCall.url).toContain("/files/upload_session/append_v2");
    expect(finishCall.url).toContain("/files/upload_session/finish");
    const finishArg = JSON.parse(finishCall.headers!["Dropbox-API-Arg"]!);
    expect(finishArg.commit.client_modified).toBe("2026-01-15T12:00:00.000Z");
    expect(finishArg.commit.mode[".tag"]).toBe("add");
  });

  test("small upload still uses /files/upload", async () => {
    const adapter = createAdapter();
    const data = new Uint8Array([1, 2, 3]);

    httpClientMock.mockResolvedValueOnce({
      status: 200,
      json: {
        ".tag": "file",
        name: "small.bin",
        path_lower: "/small.bin",
        path_display: "/small.bin",
        id: "id:small",
        client_modified: "2026-01-15T12:00:00.000Z",
        server_modified: "2026-01-15T12:00:01.000Z",
        rev: "rev_small",
        size: 3,
      },
      text: "{}",
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
    });

    await adapter.upload("small.bin", data);
    const call = httpClientMock.mock.calls[0]![0] as { url: string };
    expect(call.url).toContain("/files/upload");
    expect(call.url).not.toContain("upload_session");
  });
});
