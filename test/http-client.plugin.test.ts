import { describe, test, expect } from "bun:test";
import {
  isDropboxFileDownload,
  mapRequestUrlResponse,
  tryParseJsonText,
} from "@/http-client.plugin";

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

describe("tryParseJsonText", () => {
  test("parses object/array JSON", () => {
    expect(tryParseJsonText('{"a":1}')).toEqual({ a: 1 });
    expect(tryParseJsonText("[1,2]")).toEqual([1, 2]);
  });

  test("returns undefined for Dropbox plain-text API errors", () => {
    expect(
      tryParseJsonText(
        'Error in call to API function "files/upload": client_modified: ...',
      ),
    ).toBeUndefined();
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

  test("RPC: parses JSON from text without touching resp.json", () => {
    let jsonAccessed = false;
    const resp = mapRequestUrlResponse(
      {
        url: "https://api.dropboxapi.com/2/files/list_folder",
        method: "POST",
      },
      {
        status: 200,
        text: '{"entries":[],"cursor":"c","has_more":false}',
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        get json() {
          jsonAccessed = true;
          return { entries: [], cursor: "c", has_more: false };
        },
      },
    );

    expect(jsonAccessed).toBe(false);
    expect(resp.json).toEqual({ entries: [], cursor: "c", has_more: false });
  });

  test("plain-text API error: leaves json undefined, keeps text", () => {
    let jsonAccessed = false;
    const text =
      'Error in call to API function "files/upload": request body: client_modified: ...';
    const resp = mapRequestUrlResponse(
      {
        url: "https://content.dropboxapi.com/2/files/upload",
        method: "POST",
      },
      {
        status: 400,
        text,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        get json() {
          jsonAccessed = true;
          throw new SyntaxError('Unexpected token \'E\', "Error in c"... is not valid JSON');
        },
      },
    );

    expect(jsonAccessed).toBe(false);
    expect(resp.json).toBeUndefined();
    expect(resp.text).toBe(text);
    expect(resp.status).toBe(400);
  });
});
