import { describe, test, expect } from "bun:test";
import {
  formatClientModifiedIso,
  shouldUseUploadSession,
  splitUploadChunks,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_SESSION_THRESHOLD_BYTES,
} from "@/adapters/upload-chunk";

describe("upload chunk helpers (G16)", () => {
  test("shouldUseUploadSession above 8MB threshold", () => {
    expect(shouldUseUploadSession(UPLOAD_SESSION_THRESHOLD_BYTES)).toBe(false);
    expect(shouldUseUploadSession(UPLOAD_SESSION_THRESHOLD_BYTES + 1)).toBe(true);
  });

  test("splitUploadChunks splits on 8MB boundaries", () => {
    const data = new Uint8Array(UPLOAD_CHUNK_BYTES * 2 + 100);
    const chunks = splitUploadChunks(data);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.length).toBe(UPLOAD_CHUNK_BYTES);
    expect(chunks[1]!.length).toBe(UPLOAD_CHUNK_BYTES);
    expect(chunks[2]!.length).toBe(100);
  });

  test("formatClientModifiedIso emits UTC ISO8601", () => {
    const iso = formatClientModifiedIso(Date.UTC(2026, 6, 26, 8, 30, 0));
    expect(iso).toBe("2026-07-26T08:30:00.000Z");
  });
});
