import { App, Modal, Setting } from "obsidian";
import type { SyncPlanItem } from "../types";

const DOCS_BASE = "https://github.com/zeakd/obsidian-dropbox-sync/blob/main/docs";

/**
 * Bulk delete confirmation modal.
 * Optional sectionLabel clarifies successive prompts in the deferred Deletions phase
 * (e.g. "Files", then "Settings", then "Plugins").
 */
export class DeleteConfirmModal extends Modal {
  private confirmed = false;
  private resolve: ((confirmed: boolean) => void) | null = null;

  constructor(
    app: App,
    private deleteItems: SyncPlanItem[],
    /** Vault section short label for successive end-of-sync prompts. */
    private sectionLabel?: string,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;

    // Use the modal title bar — not an h3 inside the body.
    const title = this.sectionLabel
      ? `Delete protection — ${this.sectionLabel}`
      : "Delete protection";
    this.setTitle(title);
    contentEl.createEl("p", {
      text: `${this.deleteItems.length} item(s) will be deleted. Continue?`,
    });

    const list = contentEl.createEl("ul");
    const maxShow = 20;
    for (const item of this.deleteItems.slice(0, maxShow)) {
      const actionType = item.action.type;
      const isRemote =
        actionType === "deleteRemote" || actionType === "deleteRemoteFolder";
      const isFolder =
        actionType === "deleteRemoteFolder" || actionType === "deleteLocalFolder";
      const direction = isRemote ? "remote" : "local";
      const kind = isFolder ? "folder" : "file";
      list.createEl("li", { text: `${item.localPath} (${direction} ${kind})` });
    }
    if (this.deleteItems.length > maxShow) {
      list.createEl("li", {
        text: `... and ${this.deleteItems.length - maxShow} more`,
      });
    }

    const recoveryFrag = document.createDocumentFragment();
    recoveryFrag.appendText("Deleted files on Dropbox can be recovered from the Dropbox web trash (30\u2013180 days). ");
    const safetyLink = recoveryFrag.createEl("a", { text: "Learn more", href: `${DOCS_BASE}/sync-safety.md` });
    safetyLink.setAttr("target", "_blank");
    const recoveryEl = contentEl.createEl("p", { cls: "setting-item-description" });
    recoveryEl.appendChild(recoveryFrag);

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Delete")
          .setWarning()
          .onClick(() => {
            this.confirmed = true;
            this.close();
          }),
      )
      .addButton((btn) =>
        btn.setButtonText("Skip deletions").onClick(() => {
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
