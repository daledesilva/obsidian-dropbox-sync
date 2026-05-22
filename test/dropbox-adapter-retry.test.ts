import { describe, test, expect, mock, beforeEach } from "bun:test";
import { DropboxAdapter, DropboxRateLimitError } from "@/adapters/dropbox-adapter";
import type { HttpClient } from "@/http-client";

// httpClient mock
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
  // sleep을 즉시 resolve로 override (retry 테스트 속도)
  (adapter as any).sleep = () => Promise.resolve();
  return adapter;
}

describe("DropboxAdapter retry on 429", () => {
  beforeEach(() => {
    httpClientMock.mockReset();
  });

  test("rpcCall: 429 한 번 → retry 후 성공", async () => {
    const adapter = createAdapter();

    // 첫 호출: 429
    httpClientMock.mockResolvedValueOnce({
      status: 429,
      json: { error: { retry_after: 0 } },
      text: "rate limited",
    });

    // 두 번째 호출: 성공
    httpClientMock.mockResolvedValueOnce({
      status: 200,
      json: {
        entries: [],
        cursor: "cursor_1",
        has_more: false,
      },
      text: "{}",
    });

    const result = await adapter.listChanges();
    expect(result.entries).toEqual([]);
    expect(result.cursor).toBe("cursor_1");
    expect(httpClientMock).toHaveBeenCalledTimes(2);
  });

  test("rpcCall: 429 연속 5번 (max 4 retry 초과) → DropboxRateLimitError", async () => {
    const adapter = createAdapter();

    // 5번 연속 429
    for (let i = 0; i < 5; i++) {
      httpClientMock.mockResolvedValueOnce({
        status: 429,
        json: { error: { retry_after: 0 } },
        text: "rate limited",
      });
    }

    await expect(adapter.listChanges()).rejects.toThrow(DropboxRateLimitError);
    expect(httpClientMock).toHaveBeenCalledTimes(5);
  });

  test("download: 429 → retry 후 성공", async () => {
    const adapter = createAdapter();

    // 첫 호출: 429
    httpClientMock.mockResolvedValueOnce({
      status: 429,
      json: { error: { retry_after: 0 } },
      text: "rate limited",
    });

    // 두 번째 호출: 성공
    httpClientMock.mockResolvedValueOnce({
      status: 200,
      arrayBuffer: new ArrayBuffer(5),
      headers: {
        "dropbox-api-result": JSON.stringify({
          path_display: "/test.md",
          content_hash: "abc123",
          server_modified: "2024-01-01T00:00:00Z",
          rev: "rev_1",
          size: 5,
        }),
      },
      text: "",
    });

    const result = await adapter.download("test.md");
    expect(result.metadata.rev).toBe("rev_1");
    expect(httpClientMock).toHaveBeenCalledTimes(2);
  });

  test("upload: 429 → retry 후 성공", async () => {
    const adapter = createAdapter();
    const data = new Uint8Array([1, 2, 3]);

    // 첫 호출: 429
    httpClientMock.mockResolvedValueOnce({
      status: 429,
      json: { error: { retry_after: 0 } },
      text: "rate limited",
    });

    // 두 번째 호출: 성공
    httpClientMock.mockResolvedValueOnce({
      status: 200,
      json: {
        path_display: "/test.md",
        content_hash: "abc123",
        server_modified: "2024-01-01T00:00:00Z",
        rev: "rev_2",
        size: 3,
      },
      text: "",
    });

    const result = await adapter.upload("test.md", data);
    expect(result.rev).toBe("rev_2");
    expect(httpClientMock).toHaveBeenCalledTimes(2);
  });

  // ── Content-Type 회귀 방지 ──

  test("download: non-JSON body with dropbox-api-result header succeeds", async () => {
    const adapter = createAdapter();
    const markdown = "# hello\n\nworld";
    const buf = new TextEncoder().encode(markdown).buffer;

    httpClientMock.mockResolvedValueOnce({
      status: 200,
      arrayBuffer: buf,
      headers: {
        "dropbox-api-result": JSON.stringify({
          path_display: "/test.md",
          content_hash: "abc",
          server_modified: "2024-01-01T00:00:00Z",
          rev: "rev_md",
          size: markdown.length,
        }),
      },
      text: markdown,
      json: undefined,
    });

    const result = await adapter.download("test.md");
    expect(result.metadata.rev).toBe("rev_md");
    expect(new TextDecoder().decode(result.data)).toBe(markdown);
  });

  test("download: missing dropbox-api-result throws clear error", async () => {
    const adapter = createAdapter();

    httpClientMock.mockResolvedValueOnce({
      status: 200,
      arrayBuffer: new ArrayBuffer(0),
      headers: {},
      text: "body",
      json: undefined,
    });

    await expect(adapter.download("test.md")).rejects.toThrow(
      "dropbox-api-result header",
    );
  });

  test("download: headers에 Content-Type을 명시적으로 전달한다", async () => {
    const adapter = createAdapter();

    httpClientMock.mockResolvedValueOnce({
      status: 200,
      arrayBuffer: new ArrayBuffer(3),
      headers: {
        "dropbox-api-result": JSON.stringify({
          path_display: "/test.md",
          content_hash: "abc",
          server_modified: "2024-01-01T00:00:00Z",
          rev: "rev_ct",
          size: 3,
        }),
      },
      text: "",
    });

    await adapter.download("test.md");

    const req = httpClientMock.mock.calls[0]![0] as { headers?: Record<string, string> };
    expect(req.headers?.["Content-Type"]).toBe("application/octet-stream");
  });

  test("upload: headers에 Content-Type을 명시적으로 전달한다", async () => {
    const adapter = createAdapter();

    httpClientMock.mockResolvedValueOnce({
      status: 200,
      json: {
        path_display: "/test.md",
        content_hash: "abc",
        server_modified: "2024-01-01T00:00:00Z",
        rev: "rev_ct2",
        size: 3,
      },
      text: "",
    });

    await adapter.upload("test.md", new Uint8Array([1, 2, 3]));

    const req = httpClientMock.mock.calls[0]![0] as { headers?: Record<string, string> };
    expect(req.headers?.["Content-Type"]).toBe("application/octet-stream");
  });

  test("rpcCall: headers에 Content-Type: application/json을 전달한다", async () => {
    const adapter = createAdapter();

    httpClientMock.mockResolvedValueOnce({
      status: 200,
      json: { entries: [], cursor: "cur_ct", has_more: false },
      text: "{}",
    });

    await adapter.listChanges();

    const req = httpClientMock.mock.calls[0]![0] as { headers?: Record<string, string> };
    expect(req.headers?.["Content-Type"]).toBe("application/json");
  });

  // ── 5xx retry ──

  test("upload: 503 → retry 후 성공", async () => {
    const adapter = createAdapter();
    const data = new Uint8Array([1, 2, 3]);

    httpClientMock.mockResolvedValueOnce({
      status: 503,
      json: {},
      text: "service unavailable",
    });

    httpClientMock.mockResolvedValueOnce({
      status: 200,
      json: {
        path_display: "/test.md",
        content_hash: "abc123",
        server_modified: "2024-01-01T00:00:00Z",
        rev: "rev_3",
        size: 3,
      },
      text: "",
    });

    const result = await adapter.upload("test.md", data);
    expect(result.rev).toBe("rev_3");
    expect(httpClientMock).toHaveBeenCalledTimes(2);
  });

  test("download: 500 → retry 후 성공", async () => {
    const adapter = createAdapter();

    httpClientMock.mockResolvedValueOnce({
      status: 500,
      json: {},
      text: "internal server error",
    });

    httpClientMock.mockResolvedValueOnce({
      status: 200,
      arrayBuffer: new ArrayBuffer(5),
      headers: {
        "dropbox-api-result": JSON.stringify({
          path_display: "/test.md",
          content_hash: "abc123",
          server_modified: "2024-01-01T00:00:00Z",
          rev: "rev_1",
          size: 5,
        }),
      },
      text: "",
    });

    const result = await adapter.download("test.md");
    expect(result.metadata.rev).toBe("rev_1");
    expect(httpClientMock).toHaveBeenCalledTimes(2);
  });

  test("rpcCall: 503 → retry 후 성공", async () => {
    const adapter = createAdapter();

    httpClientMock.mockResolvedValueOnce({
      status: 503,
      json: {},
      text: "service unavailable",
    });

    httpClientMock.mockResolvedValueOnce({
      status: 200,
      json: {
        entries: [],
        cursor: "cursor_2",
        has_more: false,
      },
      text: "{}",
    });

    const result = await adapter.listChanges();
    expect(result.cursor).toBe("cursor_2");
    expect(httpClientMock).toHaveBeenCalledTimes(2);
  });

  test(
    "upload: 503 연속 5번 → 에러 throw",
    async () => {
      const adapter = createAdapter();
      const data = new Uint8Array([1]);

      for (let i = 0; i < 5; i++) {
        httpClientMock.mockResolvedValueOnce({
          status: 503,
          json: {},
          text: "service unavailable",
        });
      }

      await expect(adapter.upload("test.md", data)).rejects.toThrow("Dropbox API error 503");
      expect(httpClientMock).toHaveBeenCalledTimes(5);
    },
    20_000,
  );

  test("rpcCall: 409 reset → DropboxCursorResetError (retry 안 함)", async () => {
    const adapter = createAdapter();
    const { DropboxCursorResetError } = await import("@/adapters/dropbox-adapter");

    httpClientMock.mockResolvedValueOnce({
      status: 409,
      json: { error_summary: "reset/.." },
      text: "cursor reset",
    });

    await expect(adapter.listChanges("old_cursor")).rejects.toThrow(DropboxCursorResetError);
    expect(httpClientMock).toHaveBeenCalledTimes(1);
  });

  // ── 네트워크 에러 retry ──

  test("rpcCall: 네트워크 에러 1회 → retry 후 성공", async () => {
    const adapter = createAdapter();

    httpClientMock.mockRejectedValueOnce(new Error("The network connection was lost."));

    httpClientMock.mockResolvedValueOnce({
      status: 200,
      json: { entries: [], cursor: "cursor_net", has_more: false },
      text: "{}",
    });

    const result = await adapter.listChanges();
    expect(result.cursor).toBe("cursor_net");
    expect(httpClientMock).toHaveBeenCalledTimes(2);
  });

  test(
    "upload: 네트워크 에러 연속 5번 → throw",
    async () => {
      const adapter = createAdapter();
      const data = new Uint8Array([1]);

      for (let i = 0; i < 5; i++) {
        httpClientMock.mockRejectedValueOnce(new Error("The network connection was lost."));
      }

      await expect(adapter.upload("test.md", data)).rejects.toThrow("network connection was lost");
      expect(httpClientMock).toHaveBeenCalledTimes(5);
    },
    35_000,
  );

  test("download: 네트워크 에러 → 5xx → 성공", async () => {
    const adapter = createAdapter();

    httpClientMock.mockRejectedValueOnce(new Error("Request failed"));
    httpClientMock.mockResolvedValueOnce({ status: 503, json: {}, text: "unavailable" });
    httpClientMock.mockResolvedValueOnce({
      status: 200,
      arrayBuffer: new ArrayBuffer(3),
      headers: {
        "dropbox-api-result": JSON.stringify({
          path_display: "/test.md",
          content_hash: "abc",
          server_modified: "2024-01-01T00:00:00Z",
          rev: "rev_net",
          size: 3,
        }),
      },
      text: "",
    });

    const result = await adapter.download("test.md");
    expect(result.metadata.rev).toBe("rev_net");
    expect(httpClientMock).toHaveBeenCalledTimes(3);
  });
});
