import { App, Modal, Notice, Setting, TextComponent } from "obsidian";

/**
 * Collect a Dropbox app key via explicit Submit so settings can refresh afterward.
 * Inline text fields alone do not re-render Connect, which left users stuck after pasting a key.
 */
export class AppKeyModal extends Modal {
  private submittedKey: string | null = null;
  private resolve: ((appKey: string | null) => void) | null = null;
  private draftKey: string;

  constructor(
    app: App,
    private initialAppKey: string,
  ) {
    super(app);
    this.draftKey = initialAppKey;
  }

  onOpen(): void {
    const { contentEl } = this;
    this.setTitle("Dropbox app key");
    contentEl.createEl("p", {
      text: "Paste the App key from dropbox.com/developers/apps, then submit.",
      cls: "setting-item-description",
    });

    let textComponent: TextComponent | null = null;
    new Setting(contentEl)
      .setName("App key")
      .addText((text) => {
        textComponent = text;
        text
          .setPlaceholder("Your App Key")
          .setValue(this.draftKey)
          .onChange((value) => {
            this.draftKey = value.trim();
          });
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            this.submit();
          }
        });
      });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Submit")
          .setCta()
          .onClick(() => this.submit()),
      )
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => this.close()),
      );

    // Focus after layout so mobile keyboards and desktop paste both work cleanly.
    window.setTimeout(() => textComponent?.inputEl.focus(), 0);
  }

  private submit(): void {
    const appKey = this.draftKey.trim();
    if (!appKey) {
      new Notice("Enter an app key before submitting.");
      return;
    }
    this.submittedKey = appKey;
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolve?.(this.submittedKey);
  }

  waitForSubmit(): Promise<string | null> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }
}
