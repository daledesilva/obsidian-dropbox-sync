import { App, Modal, Setting } from "obsidian";

/**
 * Read-only list of paths affected by one sync summary chip
 * (uploads, downloads, local/cloud deletions, conflicts).
 */
export class ActionPathsModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private paths: string[],
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.title });
    contentEl.createEl("p", {
      text:
        this.paths.length === 1
          ? "1 file:"
          : `${this.paths.length} files:`,
      cls: "setting-item-description",
    });

    // Scrollable full list (no hard 20-cap) — chip modals are informational, not confirmations.
    const list = contentEl.createDiv({ cls: "dbx-sync-action-paths-list" });
    for (const path of this.paths) {
      list.createDiv({
        cls: "dbx-sync-action-paths-path",
        text: path,
        attr: { title: path },
      });
    }

    new Setting(contentEl).addButton((btn) =>
      btn.setButtonText("Close").setCta().onClick(() => this.close()),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
