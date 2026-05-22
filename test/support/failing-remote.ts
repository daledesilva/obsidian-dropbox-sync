import type {
  RemoteEntry,
  ListChangesResult,
  DownloadResult,
} from "@/types";
import type { RemoteStorage } from "@/adapters/interfaces";

/**
 * 실패를 주입할 수 있는 RemoteStorage 래퍼.
 *
 * 내부의 실제 RemoteStorage에 위임하면서,
 * 특정 호출에서 에러를 발생시킨다.
 */
export class FailingRemoteStorage implements RemoteStorage {
  private callCount = 0;
  private failAfter: number | null = null;
  private failError: Error = new Error("Network error");
  private failMethod: string | null = null;

  constructor(private inner: RemoteStorage) {}

  /**
   * n번째 호출(대상 메서드) 이후부터 실패하도록 설정.
   * method를 지정하면 해당 메서드만 카운트.
   */
  injectFailure(opts: {
    after: number;
    error?: Error;
    method?: "upload" | "download" | "delete" | "listChanges";
  }): void {
    this.failAfter = opts.after;
    this.failError = opts.error ?? new Error("Network error");
    this.failMethod = opts.method ?? null;
    this.callCount = 0;
  }

  clearFailure(): void {
    this.failAfter = null;
    this.callCount = 0;
  }

  private checkFail(method: string): void {
    if (this.failAfter === null) return;
    if (this.failMethod && this.failMethod !== method) return;

    this.callCount++;
    if (this.callCount > this.failAfter) {
      throw this.failError;
    }
  }

  async listChanges(cursor?: string): Promise<ListChangesResult> {
    this.checkFail("listChanges");
    return this.inner.listChanges(cursor);
  }

  async download(path: string): Promise<DownloadResult> {
    this.checkFail("download");
    return this.inner.download(path);
  }

  async upload(
    path: string,
    data: Uint8Array,
    rev?: string,
  ): Promise<RemoteEntry> {
    this.checkFail("upload");
    return this.inner.upload(path, data, rev);
  }

  async delete(path: string): Promise<void> {
    this.checkFail("delete");
    return this.inner.delete(path);
  }

  async move(from: string, to: string): Promise<RemoteEntry> {
    this.checkFail("move");
    return this.inner.move(from, to);
  }
}
