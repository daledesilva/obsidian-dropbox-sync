import type { HttpClient } from "../http-client";

export interface LongpollConfig {
  httpClient: HttpClient;
  getCursor: () => Promise<string | null>;
  isSyncing: () => boolean;
  isEnabled: () => boolean;
  onChanges: () => void;
  log: (msg: string, data?: unknown) => Promise<void>;
}

/**
 * Dropbox longpoll 기반 원격 변경 감지.
 *
 * cursor를 사용해 Dropbox에 30초간 대기하다가 변경이 감지되면
 * onChanges 콜백을 호출한다. 에러 시 지수 백오프 + visibility 감지로 재시도.
 */
export class LongpollManager {
  private active = false;
  private timerId: number | null = null;
  private errorCount = 0;
  private visibilityHandler: (() => void) | null = null;

  constructor(private config: LongpollConfig) {}

  schedule(): void {
    if (!this.config.isEnabled()) return;
    this.clearTimer();
    this.timerId = window.setTimeout(() => {
      this.timerId = null;
      void this.run();
    }, 1000);
  }

  stop(): void {
    this.clearTimer();
    this.removeVisibilityHandler();
    this.active = false;
    this.errorCount = 0;
  }

  private async run(): Promise<void> {
    if (!this.config.isEnabled() || this.config.isSyncing()) return;

    try {
      const cursor = await this.config.getCursor();
      if (!cursor) return;

      this.active = true;

      const resp = await this.config.httpClient({
        url: "https://notify.dropboxapi.com/2/files/list_folder/longpoll",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cursor, timeout: 30 }),
      });

      if (!this.active || !this.config.isEnabled()) return;

      if (resp.status !== 200) {
        await this.config.log("longpoll error", resp.status);
        return;
      }

      const result = resp.json as { changes: boolean; backoff?: number };

      if (result.backoff) {
        this.timerId = window.setTimeout(() => {
          this.timerId = null;
          if (result.changes) {
            this.config.onChanges();
          } else {
            this.schedule();
          }
        }, result.backoff * 1000);
        return;
      }

      this.errorCount = 0;

      if (result.changes) {
        this.config.onChanges();
      } else {
        this.schedule();
      }
    } catch (e) {
      await this.config.log("longpoll error", e);
      this.errorCount++;
      this.waitForVisibleThenReconnect();
    } finally {
      this.active = false;
    }
  }

  private waitForVisibleThenReconnect(): void {
    if (!this.config.isEnabled()) return;
    this.removeVisibilityHandler();

    const delay = Math.min(1000 * Math.pow(2, this.errorCount - 1), 30000);

    if (!document.hidden) {
      this.timerId = window.setTimeout(() => {
        this.timerId = null;
        this.schedule();
      }, delay);
    } else {
      this.visibilityHandler = () => {
        if (!document.hidden) {
          this.removeVisibilityHandler();
          this.timerId = window.setTimeout(() => {
            this.timerId = null;
            this.schedule();
          }, delay);
        }
      };
      document.addEventListener("visibilitychange", this.visibilityHandler);
    }
  }

  private clearTimer(): void {
    if (this.timerId !== null) {
      window.clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  private removeVisibilityHandler(): void {
    if (this.visibilityHandler) {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }
}
