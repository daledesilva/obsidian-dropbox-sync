import { setIcon, setTooltip } from "obsidian";
import type { FileSyncStatusRecord, FileSyncUiStatus } from "../sync/file-sync-status";

/** Same Lucide glyph as the ribbon — circular arrows. */
const STATUS_BAR_ICON = "refresh-cw";

/** Status shown for the active file (hidden = no icon). */
export type SyncStatus = "hidden" | FileSyncUiStatus;

/**
 * Per-open-file status bar (icon only).
 * Driven by FileSyncStatusTracker for the active vault file — not vault-wide sync.
 */
export class StatusBar {
  private el: HTMLElement;
  private _lastStatus: SyncStatus = "hidden";
  private _lastDetail: string | undefined;
  private _conflictSiblingPath: string | undefined;

  constructor(statusBarEl: HTMLElement) {
    this.el = statusBarEl;
    this.el.addClass("dbx-sync-statusbar");
    this.render();
  }

  get lastStatus(): SyncStatus { return this._lastStatus; }
  get lastDetail(): string | undefined { return this._lastDetail; }
  get conflictSiblingPath(): string | undefined { return this._conflictSiblingPath; }

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

  /**
   * Show status for the active file, or hide when no file / no record.
   * Success auto-clear is owned by FileSyncStatusTracker, not this view.
   */
  setActiveFileStatus(record: FileSyncStatusRecord | null): void {
    if (!record) {
      this._lastStatus = "hidden";
      this._lastDetail = undefined;
      this._conflictSiblingPath = undefined;
    } else {
      this._lastStatus = record.status;
      this._lastDetail = record.detail;
      this._conflictSiblingPath = record.conflictSiblingPath;
    }
    this.render();
  }

  destroy(): void {
    // no timers owned here
  }

  private render(): void {
    this.el.empty();
    this.el.removeClass(
      "dbx-sync-statusbar-hidden",
      "dbx-sync-statusbar-pending",
      "dbx-sync-statusbar-syncing",
      "dbx-sync-statusbar-success",
      "dbx-sync-statusbar-error",
      "dbx-sync-statusbar-conflict",
    );

    const label = this.ariaLabelForStatus();

    switch (this._lastStatus) {
      case "hidden":
        this.el.addClass("dbx-sync-statusbar-hidden");
        this.el.setAttr("aria-label", "Dropbox sync");
        setTooltip(this.el, "Dropbox sync");
        break;
      case "pending":
        this.el.addClass("dbx-sync-statusbar-pending");
        setIcon(this.el, STATUS_BAR_ICON);
        this.el.setAttr("aria-label", label);
        setTooltip(this.el, label);
        break;
      case "syncing":
        this.el.addClass("dbx-sync-statusbar-syncing");
        setIcon(this.el, STATUS_BAR_ICON);
        this.el.setAttr("aria-label", label);
        setTooltip(this.el, label);
        break;
      case "success":
        this.el.addClass("dbx-sync-statusbar-success");
        setIcon(this.el, STATUS_BAR_ICON);
        this.el.setAttr("aria-label", label);
        setTooltip(this.el, label);
        break;
      case "error":
        this.el.addClass("dbx-sync-statusbar-error");
        setIcon(this.el, STATUS_BAR_ICON);
        this.el.setAttr("aria-label", label);
        setTooltip(this.el, label);
        break;
      case "conflict":
        this.el.addClass("dbx-sync-statusbar-conflict");
        setIcon(this.el, STATUS_BAR_ICON);
        this.el.setAttr("aria-label", label);
        setTooltip(this.el, label);
        break;
    }
  }

  private ariaLabelForStatus(): string {
    switch (this._lastStatus) {
      case "pending":
        return this._lastDetail
          ?? "This file has local changes that have not synced to Dropbox yet";
      case "syncing":
        return this._lastDetail ?? "This file is currently syncing with Dropbox";
      case "success":
        return this._lastDetail ?? "This file synced with Dropbox";
      case "error":
        return this._lastDetail ?? "Sync failed for this file";
      case "conflict":
        return this._lastDetail
          ?? "Conflict: local and Dropbox both changed — click for details";
      default:
        return "Dropbox sync";
    }
  }
}
