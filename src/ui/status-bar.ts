export type SyncStatus = "idle" | "syncing" | "success" | "error";

export class StatusBar {
  private el: HTMLElement;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private _lastStatus: SyncStatus = "idle";
  private _lastDetail: string | undefined;
  private _backgroundSyncEnabled = false;

  constructor(statusBarEl: HTMLElement) {
    this.el = statusBarEl;
  }

  get lastStatus(): SyncStatus { return this._lastStatus; }
  get lastDetail(): string | undefined { return this._lastDetail; }

  set backgroundSyncEnabled(value: boolean) {
    this._backgroundSyncEnabled = value;
    if (this._lastStatus === "idle") {
      this.render();
    }
  }

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

  update(status: SyncStatus, detail?: string): void {
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }

    this._lastStatus = status;
    this._lastDetail = detail;
    this.render();

    if (status === "success") {
      this.timerId = setTimeout(() => this.update("idle"), 5000);
    }
  }

  destroy(): void {
    if (this.timerId) clearTimeout(this.timerId);
  }

  private render(): void {
    this.el.empty();
    this.el.removeClass("dbx-sync-statusbar-muted", "dbx-sync-statusbar-error");

    switch (this._lastStatus) {
      case "idle":
        if (this._backgroundSyncEnabled) {
          this.el.setText("Dropbox: idle");
        } else {
          this.el.setText("Dropbox: manual");
        }
        break;
      case "syncing":
        this.el.setText(this._lastDetail ? `⟳ ${this._lastDetail}` : "⟳ syncing...");
        break;
      case "success":
        this.el.setText(`Dropbox: ${this._lastDetail ?? "synced"}`);
        break;
      case "error":
        this.el.setText(`Dropbox: ${this._lastDetail ?? "error"}`);
        this.el.addClass("dbx-sync-statusbar-error");
        break;
    }
  }
}
