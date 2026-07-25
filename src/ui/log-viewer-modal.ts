import { App, Modal, Setting, Notice } from "obsidian";

export class LogViewerModal extends Modal {
  constructor(
    app: App,
    private logContent: string,
    private deviceId: string,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;

    // Use the modal title bar — not an h3 inside the body.
    this.setTitle(`Sync Logs (${this.deviceId})`);

    const ta = contentEl.createEl("textarea", { cls: "dbx-sync-log-textarea" });
    ta.value = this.logContent;
    ta.readOnly = true;

    // Scroll to bottom (latest logs)
    ta.scrollTop = ta.scrollHeight;

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Copy to clipboard")
          .setCta()
          .onClick(async () => {
            await navigator.clipboard.writeText(this.logContent);
            new Notice("Logs copied to clipboard");
          }),
      )
      .addButton((btn) =>
        btn.setButtonText("Close").onClick(() => this.close()),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
