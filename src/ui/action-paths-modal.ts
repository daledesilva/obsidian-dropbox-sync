import { App, Modal, Notice, Setting } from "obsidian";

/**
 * Read-only list of paths affected by one sync summary chip
 * (uploads, downloads, local/cloud deletions, conflicts).
 * Copy joins the full path list with newlines for paste into editors / spreadsheets.
 * While a sync is still running the panel can appendPath/setPaths so the open modal grows.
 */
export class ActionPathsModal extends Modal {
  private countEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private onCloseCallback: (() => void) | null = null;

  constructor(
    app: App,
    private title: string,
    private paths: string[],
  ) {
    super(app);
  }

  /** Called when the modal closes so the progress panel can drop its live reference. */
  setOnCloseCallback(callback: (() => void) | null): void {
    this.onCloseCallback = callback;
  }

  onOpen(): void {
    const { contentEl } = this;
    // Use the modal title bar — not an h3 inside the body.
    this.setTitle(this.title);
    this.countEl = contentEl.createEl("p", {
      text: formatFileCountLabel(this.paths.length),
      cls: "setting-item-description",
    });

    // Scrollable full list (no hard 20-cap) — chip modals are informational, not confirmations.
    this.listEl = contentEl.createDiv({ cls: "dbx-sync-action-paths-list" });
    for (const path of this.paths) {
      this.appendPathRow(path);
    }

    // One path per line so the clipboard paste is usable in editors / spreadsheets.
    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Copy to clipboard")
          .setCta()
          .onClick(async () => {
            await navigator.clipboard.writeText(this.paths.join("\n"));
            new Notice(
              this.paths.length === 1
                ? "Path copied to clipboard"
                : "Paths copied to clipboard",
            );
          }),
      )
      .addButton((btn) =>
        btn.setButtonText("Close").onClick(() => this.close()),
      );
  }

  /** Replace the full path list (e.g. reconcile after markResult). */
  setPaths(paths: string[]): void {
    this.paths = [...paths];
    this.refreshCount();
    if (!this.listEl) return;
    this.listEl.empty();
    for (const path of this.paths) {
      this.appendPathRow(path);
    }
  }

  /**
   * Append one completed path while the modal stays open.
   * Auto-scrolls when the user is already near the bottom so live sync feels continuous.
   */
  appendPath(path: string): void {
    const trimmed = path.trim();
    if (!trimmed) return;
    this.paths.push(trimmed);
    this.refreshCount();
    if (!this.listEl) return;
    const nearBottom = this.isListNearBottom();
    this.appendPathRow(trimmed);
    if (nearBottom) {
      this.listEl.scrollTop = this.listEl.scrollHeight;
    }
  }

  onClose(): void {
    this.countEl = null;
    this.listEl = null;
    this.contentEl.empty();
    const callback = this.onCloseCallback;
    this.onCloseCallback = null;
    callback?.();
  }

  private refreshCount(): void {
    this.countEl?.setText(formatFileCountLabel(this.paths.length));
  }

  private appendPathRow(path: string): void {
    if (!this.listEl) return;
    this.listEl.createDiv({
      cls: "dbx-sync-action-paths-path",
      text: path,
      attr: { title: path },
    });
  }

  /** True when scrolled within ~48px of the bottom (or list not yet scrollable). */
  private isListNearBottom(): boolean {
    if (!this.listEl) return true;
    const remaining =
      this.listEl.scrollHeight - this.listEl.scrollTop - this.listEl.clientHeight;
    return remaining <= 48;
  }
}

function formatFileCountLabel(count: number): string {
  return count === 1 ? "1 file:" : `${count} files:`;
}
