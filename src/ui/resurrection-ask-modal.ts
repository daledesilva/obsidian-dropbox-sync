import { App, Modal, Setting } from "obsidian";
import type { ResurrectionChoice } from "../sync/resurrection-guard";

/**
 * One decision for all ambiguous new_local paths (R6). Per-file modals made first
 * sync unusable; Cancel must defer (not discard) so closing the dialog never
 * mass-deletes the vault.
 */
export class ResurrectionAskModal extends Modal {
  private choice: ResurrectionChoice = "defer";
  private resolve: ((choice: ResurrectionChoice) => void) | null = null;

  constructor(
    app: App,
    private localPaths: string[],
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    const count = this.localPaths.length;
    this.setTitle(count === 1 ? "Upload local file?" : `Upload ${count} local files?`);

    // Dimmer click closes Obsidian modals by default; that equals Cancel/defer.
    // Stop the backdrop handler so only Upload / Discard / Cancel (or Esc/X) close it.
    const backdrop = this.containerEl.querySelector(".modal-bg");
    if (backdrop) {
      backdrop.addEventListener(
        "click",
        (event) => event.stopImmediatePropagation(),
        { capture: true },
      );
    }

    contentEl.createEl("p", {
      text: count === 1
        ? `"${this.localPaths[0]}" exists locally but not on Dropbox, and there is no deletion history for this path.`
        : `${count} files exist locally but not on Dropbox, with no deletion history for those paths.`,
    });

    if (count > 1) {
      const list = contentEl.createEl("ul", { cls: "dbx-sync-resurrection-ask-list" });
      const maxShow = 12;
      for (const path of this.localPaths.slice(0, maxShow)) {
        list.createEl("li", { text: path });
      }
      if (count > maxShow) {
        list.createEl("li", { text: `… and ${count - maxShow} more` });
      }
    }

    contentEl.createEl("p", {
      text: count === 1
        ? "Upload adds the file to Dropbox. Discard removes the local copy without uploading. Cancel skips for now."
        : "Upload all adds them to Dropbox. Discard all removes the local copies without uploading. Cancel skips for now.",
      cls: "mod-warning",
    });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText(count === 1 ? "Upload" : "Upload all")
          .setCta()
          .onClick(() => {
            this.choice = "upload";
            this.close();
          }),
      )
      .addButton((btn) =>
        btn
          .setButtonText(count === 1 ? "Discard local copy" : "Discard all local copies")
          .setWarning()
          .onClick(() => {
            this.choice = "discard";
            this.close();
          }),
      )
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => {
          this.choice = "defer";
          this.close();
        }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolve?.(this.choice);
  }

  waitForChoice(): Promise<ResurrectionChoice> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }
}
