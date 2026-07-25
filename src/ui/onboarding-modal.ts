import { App, Modal, Setting } from "obsidian";

export class OnboardingModal extends Modal {
  constructor(
    app: App,
    private actions: {
      onOpenSettings: () => void;
    },
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;

    // Use the modal title bar — not an h2 inside the body.
    this.setTitle("Dropbox sync");
    contentEl.createEl("p", {
      text: "Sync your Obsidian vault with Dropbox. Use the same vault across multiple devices.",
    });

    const steps = contentEl.createEl("ol", { cls: "dbx-sync-onboard-steps" });

    steps.createEl("li", { text: "Connect your Dropbox account." });
    steps.createEl("li", { text: "Set a vault ID (your Dropbox folder name)." });
    steps.createEl("li", { text: "Enable sync to start syncing automatically." });

    contentEl.createEl("p", {
      text: "You can get started right from settings.",
      cls: "setting-item-description",
    });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Open settings")
          .setCta()
          .onClick(() => {
            this.close();
            this.actions.onOpenSettings();
          }),
      )
      .addButton((btn) =>
        btn.setButtonText("Later").onClick(() => this.close()),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
