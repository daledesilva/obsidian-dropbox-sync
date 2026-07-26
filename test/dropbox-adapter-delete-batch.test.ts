import { describe, test, expect, mock, beforeEach } from "bun:test";
import { DropboxAdapter } from "@/adapters/dropbox-adapter";
import type { HttpClient } from "@/http-client";

const httpClientMock = mock() as unknown as ReturnType<typeof mock> & HttpClient;

function createAdapter(remotePath = ""): DropboxAdapter {
  return new DropboxAdapter({
    httpClient: (...args: unknown[]) => (httpClientMock as any)(...args),
    appKey: "test-key",
    remotePath,
    getAccessToken: () => "test-token",
    getRefreshToken: () => "test-refresh",
    getTokenExpiry: () => Date.now() + 3600_000,
    onTokenRefreshed: () => {},
  });
}

function okResp(json: unknown) {
  return {
    status: 200,
    json,
    text: JSON.stringify(json),
    headers: {},
    arrayBuffer: new ArrayBuffer(0),
  };
}

describe("DropboxAdapter.deleteBatch", () => {
  beforeEach(() => {
    httpClientMock.mockReset();
  });

  test("sync complete maps success and not_found soft-ok", async () => {
    const adapter = createAdapter();
    httpClientMock.mockResolvedValueOnce(
      okResp({
        ".tag": "complete",
        entries: [
          { ".tag": "success", metadata: { ".tag": "file" } },
          {
            ".tag": "failure",
            failure: {
              ".tag": "path_lookup",
              path_lookup: { ".tag": "not_found" },
            },
          },
        ],
      }),
    );

    const results = await adapter.deleteBatch(["a.md", "gone.md"]);
    expect(results).toEqual([
      { path: "a.md", ok: true },
      { path: "gone.md", ok: true },
    ]);
    expect(httpClientMock).toHaveBeenCalledTimes(1);
    const call = (httpClientMock.mock.calls[0] as unknown[])[0] as {
      url: string;
      body: string;
    };
    expect(call.url).toContain("/files/delete_batch");
    expect(JSON.parse(call.body).entries).toEqual([
      { path: "/a.md" },
      { path: "/gone.md" },
    ]);
  });

  test("async_job_id polls until complete", async () => {
    const adapter = createAdapter("/vault");
    // Patch delay via abort-utils path: override by making poll return immediately.
    // First: launch async, then in_progress, then complete.
    httpClientMock
      .mockResolvedValueOnce(
        okResp({ ".tag": "async_job_id", async_job_id: "job-1" }),
      )
      .mockResolvedValueOnce(okResp({ ".tag": "in_progress" }))
      .mockResolvedValueOnce(
        okResp({
          ".tag": "complete",
          entries: [{ ".tag": "success", metadata: { ".tag": "folder" } }],
        }),
      );

    const results = await adapter.deleteBatch(["notes"]);
    expect(results).toEqual([{ path: "notes", ok: true }]);
    expect(httpClientMock).toHaveBeenCalledTimes(3);
    const launchBody = JSON.parse(
      ((httpClientMock.mock.calls[0] as unknown[])[0] as { body: string }).body,
    );
    expect(launchBody.entries[0].path).toBe("/vault/notes");
    const checkUrl = (
      (httpClientMock.mock.calls[1] as unknown[])[0] as { url: string }
    ).url;
    expect(checkUrl).toContain("/files/delete_batch/check");
  });

  test("too_many_files surfaces per-entry flag", async () => {
    const adapter = createAdapter();
    httpClientMock.mockResolvedValueOnce(
      okResp({
        ".tag": "complete",
        entries: [
          {
            ".tag": "failure",
            failure: { ".tag": "too_many_files" },
          },
        ],
      }),
    );

    const results = await adapter.deleteBatch(["huge"]);
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.tooManyFiles).toBe(true);
  });
});

describe("DropboxAdapter.listFilePathLowersUnder", () => {
  beforeEach(() => {
    httpClientMock.mockReset();
  });

  test("pages through list_folder/continue and returns files with hashes", async () => {
    const adapter = createAdapter("/vault");
    httpClientMock
      .mockResolvedValueOnce(
        okResp({
          entries: [
            {
              ".tag": "file",
              name: "a.md",
              path_lower: "/vault/notes/a.md",
              path_display: "/vault/notes/a.md",
              id: "id:a",
              client_modified: "2020-01-01T00:00:00Z",
              server_modified: "2020-01-01T00:00:00Z",
              rev: "r1",
              size: 1,
              content_hash: "hash-a",
            },
            {
              ".tag": "folder",
              name: "sub",
              path_lower: "/vault/notes/sub",
              path_display: "/vault/notes/sub",
              id: "id:folder",
            },
          ],
          cursor: "c1",
          has_more: true,
        }),
      )
      .mockResolvedValueOnce(
        okResp({
          entries: [
            {
              ".tag": "file",
              name: "b.md",
              path_lower: "/vault/notes/b.md",
              path_display: "/vault/notes/b.md",
              id: "id:b",
              client_modified: "2020-01-01T00:00:00Z",
              server_modified: "2020-01-01T00:00:00Z",
              rev: "r2",
              size: 1,
              content_hash: "hash-b",
            },
          ],
          cursor: "c2",
          has_more: false,
        }),
      );

    const listed = await adapter.listFilePathLowersUnder("notes");
    expect(listed).toEqual([
      { pathLower: "notes/a.md", contentHash: "hash-a", isFolder: false },
      { pathLower: "notes/sub", contentHash: "", isFolder: true },
      { pathLower: "notes/b.md", contentHash: "hash-b", isFolder: false },
    ]);
    expect(httpClientMock).toHaveBeenCalledTimes(2);
  });

  test("path/not_found returns empty list", async () => {
    const adapter = createAdapter();
    httpClientMock.mockResolvedValueOnce({
      status: 409,
      json: {
        error_summary: "path/not_found/...",
        error: { ".tag": "path", path: { ".tag": "not_found" } },
      },
      text: "path/not_found",
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
    });
    const listed = await adapter.listFilePathLowersUnder("missing");
    expect(listed).toEqual([]);
  });
});
