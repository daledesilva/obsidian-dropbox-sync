import { Modal, Notice, Setting, TFile, type App } from "obsidian";
import {
  findNewestConflictSibling,
} from "../sync/conflict-handlers";

export interface ConflictCompareModalOptions {
  localPath: string;
  conflictSiblingPath?: string;
}

/**
 * Explains a keep_both conflict for the active file and offers Compare,
 * which opens the local file and the remote snapshot sibling in a split
 * (side-by-side when the viewport is wider than tall, else stacked).
 */
export class ConflictCompareModal extends Modal {
  constructor(
    app: App,
    private options: ConflictCompareModalOptions,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    const { localPath } = this.options;
    const sibling = this.resolveSiblingPath();

    contentEl.createEl("h3", { text: "Sync conflict" });
    contentEl.createEl("p", {
      text:
        "This file changed both on this device and in Dropbox. "
        + "Your local version was kept at the original path, and the Dropbox version "
        + "was saved as a conflict copy so you can compare them.",
    });

    contentEl.createEl("p", {
      text: `Local: ${localPath}`,
      cls: "setting-item-description",
    });
    contentEl.createEl("p", {
      text: sibling
        ? `Dropbox copy: ${sibling}`
        : "Dropbox copy: (conflict file not found — it may have been moved or deleted)",
      cls: "setting-item-description",
    });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Compare")
          .setCta()
          .setDisabled(!sibling)
          .onClick(() => {
            void this.openCompare(localPath, sibling!);
          }),
      )
      .addButton((btn) =>
        btn.setButtonText("Close").onClick(() => this.close()),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private resolveSiblingPath(): string | null {
    if (this.options.conflictSiblingPath) {
      const existing = this.app.vault.getAbstractFileByPath(this.options.conflictSiblingPath);
      if (existing instanceof TFile) return this.options.conflictSiblingPath;
    }
    const paths = this.app.vault.getFiles().map((f) => f.path);
    return findNewestConflictSibling(paths, this.options.localPath);
  }

  private async openCompare(localPath: string, siblingPath: string): Promise<void> {
    const localFile = this.app.vault.getAbstractFileByPath(localPath);
    const siblingFile = this.app.vault.getAbstractFileByPath(siblingPath);
    if (!(localFile instanceof TFile) || !(siblingFile instanceof TFile)) {
      new Notice("Could not open conflict files — one of them is missing.");
      return;
    }

    // Wider than tall → side-by-side (vertical split); taller → stacked (horizontal).
    const wide = window.innerWidth >= window.innerHeight;
    const direction = wide ? "vertical" : "horizontal";

    await this.app.workspace.getLeaf(false).openFile(localFile);
    const splitLeaf = this.app.workspace.getLeaf("split", direction);
    await splitLeaf.openFile(siblingFile);
    this.close();
  }
}
