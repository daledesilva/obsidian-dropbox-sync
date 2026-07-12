import { describe, test, expect } from "bun:test";
import { isDropboxFileDownload, mapRequestUrlResponse } from "@/http-client.plugin";

describe("isDropboxFileDownload", () => {
  test("matches Dropbox content download endpoint", () => {
    expect(
      isDropboxFileDownload("https://content.dropboxapi.com/2/files/download"),
    ).toBe(true);
  });

  test("does not match upload or RPC", () => {
    expect(
      isDropboxFileDownload("https://content.dropboxapi.com/2/files/upload"),
    ).toBe(false);
    expect(
      isDropboxFileDownload("https://api.dropboxapi.com/2/files/list_folder"),
    ).toBe(false);
  });
});

describe("mapRequestUrlResponse", () => {
  test("download: never reads resp.json", () => {
    let jsonAccessed = false;
    const body = "# markdown\n\ncontent";
    const resp = mapRequestUrlResponse(
      {
        url: "https://content.dropboxapi.com/2/files/download",
        method: "POST",
      },
      {
        status: 200,
        text: body,
        headers: { "dropbox-api-result": "{}" },
        arrayBuffer: new TextEncoder().encode(body).buffer,
        get json() {
          jsonAccessed = true;
          throw new SyntaxError("must not parse download body as JSON");
        },
      },
    );

    expect(jsonAccessed).toBe(false);
    expect(resp.json).toBeUndefined();
    expect(resp.text).toBe(body);
    expect(resp.arrayBuffer.byteLength).toBeGreaterThan(0);
  });

  test("RPC: passes through resp.json", () => {
    const resp = mapRequestUrlResponse(
      {
        url: "https://api.dropboxapi.com/2/files/list_folder",
        method: "POST",
      },
      {
        status: 200,
        text: "{}",
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: { entries: [], cursor: "c", has_more: false },
      },
    );

    expect(resp.json).toEqual({ entries: [], cursor: "c", has_more: false });
  });
});
