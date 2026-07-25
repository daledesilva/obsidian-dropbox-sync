import { App, Modal, Setting, setIcon } from "obsidian";
import { SyncInterruptInfoModal } from "./sync-interrupt-info-modal";

/**
 * Confirm before aborting an in-flight sync (explorer panel Cancel / ribbon).
 * Modal chrome title is "Stop Syncing"; body explains resume-from-where-left-off.
 * Safety line + info icon opens the longer interrupt-info modal.
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
    this.setTitle("Stop Syncing");
    contentEl.createEl("p", {
      text:
        "Cancelling the sync won't break your vault. You can cancel any time or simply close Obsidian. Syncing will resume from where it left off when run again.",
    });

    // Plugin half-sync risk + accent circle-i opens the fuller interrupt-info modal.
    const safety = contentEl.createDiv({ cls: "dbx-sync-cancel-safety" });
    safety.createSpan({ text: "Half synced plugins may stop working until fully synced" });
    const infoBtn = safety.createSpan({
      cls: "dbx-sync-cancel-safety-info",
      attr: {
        role: "button",
        tabindex: "0",
        "aria-label": "More about interrupting sync",
      },
    });
    setIcon(infoBtn, "info");
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
