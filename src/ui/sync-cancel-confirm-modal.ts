import { App, Modal, Setting } from "obsidian";

/**
 * Confirm before aborting an in-flight sync (explorer panel Cancel / ribbon).
 * Modal chrome title is "Stop Syncing?"; body explains resume-from-where-left-off.
 */
export class SyncCancelConfirmModal extends Modal {
  private confirmed = false;
  private resolve: ((confirmed: boolean) => void) | null = null;

  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    // Use the modal title bar — not an h3 inside the body.
    this.setTitle("Stop Syncing?");
    contentEl.createEl("p", {
      text:
        "Cancelling the sync won't break your vault. You can cancel any time or simply close Obsidian. Syncing will resume from where it left off when run again.",
    });

    contentEl.createDiv({
      cls: "dbx-sync-cancel-safety",
      text: "Half synced plugins may stop working until fully synced.",
    });

    // Resume (dismiss) first; Stop Syncing (abort) second — swapped vs the old order.
    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Resume").onClick(() => this.close()),
      )
      .addButton((btn) =>
        btn
          .setButtonText("Stop Syncing")
          .setWarning()
          .onClick(() => {
            this.confirmed = true;
            this.close();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolve?.(this.confirmed);
  }

  waitForConfirmation(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }
}
