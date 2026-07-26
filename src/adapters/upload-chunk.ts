/** Switch from single-shot /files/upload to upload_session above this size (G16). */
export const UPLOAD_SESSION_THRESHOLD_BYTES = 8 * 1024 * 1024;

/** Recommended chunk size for upload_session append payloads. */
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

/** Dropbox hard cap per upload_session request body. */
export const UPLOAD_CHUNK_MAX_BYTES = 150 * 1024 * 1024;

/** True when Dropbox requires upload_session instead of /files/upload. */
export function shouldUseUploadSession(byteLength: number): boolean {
  return byteLength > UPLOAD_SESSION_THRESHOLD_BYTES;
}

/**
 * Split a buffer into upload_session chunks (each ≤ UPLOAD_CHUNK_MAX_BYTES).
 * Exported for unit tests — DropboxAdapter uses the same sizing at runtime.
 */
export function splitUploadChunks(
  data: Uint8Array,
  chunkSize = UPLOAD_CHUNK_BYTES,
): Uint8Array[] {
  if (data.length === 0) return [new Uint8Array(0)];
  const size = Math.min(Math.max(1, chunkSize), UPLOAD_CHUNK_MAX_BYTES);
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < data.length; offset += size) {
    chunks.push(data.subarray(offset, Math.min(offset + size, data.length)));
  }
  return chunks;
}

/**
 * ISO8601 UTC string for Dropbox client_modified (G11).
 * Dropbox Stone requires second precision (`%Y-%m-%dT%H:%M:%SZ`); milliseconds
 * are rejected as plain-text "Error in call to API..." (not JSON).
 */
export function formatClientModifiedIso(mtimeMs: number): string {
  return new Date(mtimeMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}
