import { App, Modal, Setting } from "obsidian";
import { SyncInterruptInfoModal } from "./sync-interrupt-info-modal";

/**
 * Confirm before aborting an in-flight sync (explorer panel Cancel / ribbon).
 * Includes a one-line vault-safety note with a link into the longer interrupt info modal.
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
    contentEl.createEl("h3", { text: "Cancel sync?" });
    contentEl.createEl("p", {
      text: "Sync will stop now. Unfinished files stay as they are until the next sync.",
    });

    // Safety line + accent “?” opens the fuller interrupt-info modal.
    const safety = contentEl.createDiv({ cls: "dbx-sync-cancel-safety" });
    safety.createSpan({ text: "Cancelling won't break your vault." });
    const infoBtn = safety.createSpan({
      text: "?",
      cls: "dbx-sync-cancel-safety-info",
      attr: {
        role: "button",
        tabindex: "0",
        "aria-label": "More about interrupting sync",
      },
    });
    infoBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      new SyncInterruptInfoModal(this.app).open();
    });
    infoBtn.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      new SyncInterruptInfoModal(this.app).open();
    });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Cancel sync")
          .setWarning()
          .onClick(() => {
            this.confirmed = true;
            this.close();
          }),
      )
      .addButton((btn) =>
        btn.setButtonText("Keep syncing").onClick(() => this.close()),
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
