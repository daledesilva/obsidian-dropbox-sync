/** Dropbox API 응답 타입 */

export interface DropboxFileMetadata {
  ".tag": "file";
  name: string;
  path_lower: string;
  path_display: string;
  id: string;
  client_modified: string;
  server_modified: string;
  rev: string;
  size: number;
  content_hash?: string;
  is_downloadable?: boolean;
}

export interface DropboxFolderMetadata {
  ".tag": "folder";
  name: string;
  path_lower: string;
  path_display: string;
  id: string;
}

export interface DropboxDeletedMetadata {
  ".tag": "deleted";
  name: string;
  path_lower: string;
  path_display: string;
}

export type DropboxMetadata =
  | DropboxFileMetadata
  | DropboxFolderMetadata
  | DropboxDeletedMetadata;

export interface DropboxListFolderResult {
  entries: DropboxMetadata[];
  cursor: string;
  has_more: boolean;
}

export interface DropboxListRevisionsResult {
  entries: DropboxFileMetadata[];
  is_deleted: boolean;
}

export interface DropboxTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  uid: string;
  account_id: string;
}

export interface DropboxErrorResponse {
  error_summary: string;
  error: {
    ".tag": string;
    retry_after?: number;
  };
}
