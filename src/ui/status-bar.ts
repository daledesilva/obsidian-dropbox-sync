import { setIcon } from "obsidian";

/**
 * Background-sync status bar states (icon only).
 * pending = out of sync; success = green tick then auto-hides; hidden = nothing shown.
 */
export type SyncStatus = "hidden" | "pending" | "syncing" | "success" | "error";

export class StatusBar {
  private el: HTMLElement;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private _lastStatus: SyncStatus = "hidden";
  private _lastDetail: string | undefined;

  constructor(statusBarEl: HTMLElement) {
    this.el = statusBarEl;
    this.el.addClass("dbx-sync-statusbar");
    this.render();
  }

  get lastStatus(): SyncStatus { return this._lastStatus; }
  get lastDetail(): string | undefined { return this._lastDetail; }

  onClick(callback: () => void): void {
    this.el.addClass("dbx-sync-statusbar-clickable");
    this.el.addEventListener("click", callback);
  }

  onContextMenu(callback: (evt: MouseEvent) => void): void {
    this.el.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      callback(evt);
    });
  }

  /** Local/remote change queued for background sync — show out-of-sync icon. */
  markPending(detail?: string): void {
    this.update("pending", detail);
  }

  update(status: SyncStatus, detail?: string): void {
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }

    this._lastStatus = status;
    this._lastDetail = detail;
    this.render();

    // Green tick is brief confirmation, then the bar clears until the next pending change.
    if (status === "success") {
      this.timerId = setTimeout(() => this.update("hidden"), 5000);
    }
  }

  destroy(): void {
    if (this.timerId) clearTimeout(this.timerId);
  }

  private render(): void {
    this.el.empty();
    this.el.removeClass(
      "dbx-sync-statusbar-hidden",
      "dbx-sync-statusbar-pending",
      "dbx-sync-statusbar-success",
      "dbx-sync-statusbar-error",
    );

    switch (this._lastStatus) {
      case "hidden":
        this.el.addClass("dbx-sync-statusbar-hidden");
        this.el.setAttr("aria-label", "Dropbox sync");
        break;
      case "pending":
      case "syncing":
        // Out of sync (and still out of sync while a background run is in flight).
        this.el.addClass("dbx-sync-statusbar-pending");
        setIcon(this.el, "cloud-off");
        this.el.setAttr(
          "aria-label",
          this._lastStatus === "syncing" ? "Dropbox: syncing" : "Dropbox: out of sync",
        );
        break;
      case "success":
        this.el.addClass("dbx-sync-statusbar-success");
        setIcon(this.el, "check");
        this.el.setAttr("aria-label", "Dropbox: synced");
        break;
      case "error":
        this.el.addClass("dbx-sync-statusbar-error");
        setIcon(this.el, "alert-circle");
        this.el.setAttr("aria-label", `Dropbox: ${this._lastDetail ?? "error"}`);
        break;
    }
  }
}
