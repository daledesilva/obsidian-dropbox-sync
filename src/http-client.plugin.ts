/**
 * Obsidian requestUrl 기반 HttpClient 구현.
 *
 * Electron/모바일의 CORS 우회를 활용한다.
 * non-2xx에서 throw하지 않도록 throw: false를 하드코딩한다.
 */
import { requestUrl } from "obsidian";
import { normalizeHeaders, type HttpRequest, type HttpResponse } from "./http-client";
import type { HttpClient } from "./http-client";

/** Dropbox content download — body is file bytes; never parse as JSON. */
export function isDropboxFileDownload(url: string): boolean {
  return url.includes("/files/download");
}

type RequestUrlResult = {
  status: number;
  text: string;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  /** Obsidian may throw SyntaxError when this getter runs on plain-text bodies. */
  json: unknown;
};

/**
 * Parse response text as JSON only when it looks like an object/array.
 * Dropbox Stone validation errors return plain text ("Error in call to API...")
 * — never touch Obsidian's resp.json getter for those (it throws SyntaxError).
 */
export function tryParseJsonText(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Map requestUrl result to HttpResponse.
 * Never reads Obsidian resp.json — parse from text so plain-text API errors
 * surface as text/status instead of SyntaxError.
 */
export function mapRequestUrlResponse(req: HttpRequest, resp: RequestUrlResult): HttpResponse {
  // Downloads are binary/file bodies — never JSON-parse.
  const json = isDropboxFileDownload(req.url)
    ? undefined
    : tryParseJsonText(resp.text);
  return {
    status: resp.status,
    json,
    text: resp.text,
    headers: normalizeHeaders(resp.headers),
    arrayBuffer: resp.arrayBuffer,
  };
}

export const obsidianHttpClient: HttpClient = async (req) => {
  // headers에서 Content-Type을 추출하여 Obsidian requestUrl의 contentType 파라미터로 전달.
  // requestUrl은 contentType을 별도 파라미터로 받는 Obsidian 고유 API.
  const headers = { ...req.headers };
  const contentType = headers["Content-Type"];
  delete headers["Content-Type"];

  const resp = await requestUrl({
    url: req.url,
    method: req.method,
    contentType,
    headers,
    body: req.body,
    throw: false,
  });

  return mapRequestUrlResponse(req, resp);
};
