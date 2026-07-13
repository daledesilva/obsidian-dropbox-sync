import { App, Modal, Setting } from "obsidian";

export class ConfirmModal extends Modal {
  private confirmed = false;
  private resolve: ((confirmed: boolean) => void) | null = null;

  constructor(
    app: App,
    private title: string,
    private message: string,
    private warning?: string,
    private confirmLabel = "Confirm",
    private cancelLabel = "Cancel",
    /** When true, the confirm button uses Obsidian's warning style (e.g. cancel sync). */
    private confirmIsWarning = false,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.title });
    contentEl.createEl("p", { text: this.message });
    if (this.warning) {
      contentEl.createEl("p", {
        text: this.warning,
        cls: "mod-warning",
      });
    }

    new Setting(contentEl)
      .addButton((btn) => {
        btn.setButtonText(this.confirmLabel).onClick(() => {
          this.confirmed = true;
          this.close();
        });
        if (this.confirmIsWarning) {
          btn.setWarning();
        } else {
          btn.setCta();
        }
      })
      .addButton((btn) =>
        btn.setButtonText(this.cancelLabel).onClick(() => this.close()),
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
