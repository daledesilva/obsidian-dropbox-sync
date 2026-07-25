import { App, Modal, Setting } from "obsidian";

/**
 * Short reassurance about cancel / closing Obsidian mid-sync.
 * Opened from the explorer sync panel info control.
 */
export class SyncInterruptInfoModal extends Modal {
  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Interrupting sync" });

    contentEl.createEl("p", {
      text: "You can cancel sync or close Obsidian at any time. Your vault will not break.",
    });
    contentEl.createEl("p", {
      text: "If plugins were only partly synced, they may not work until you reopen Obsidian and finish the sync.",
    });
    contentEl.createEl("p", {
      text: "When you sync again, unfinished work is completed first.",
    });

    new Setting(contentEl).addButton((btn) =>
      btn.setButtonText("Got it").setCta().onClick(() => this.close()),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
