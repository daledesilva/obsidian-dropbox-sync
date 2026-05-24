import { App, Modal, Notice, Platform, Setting } from "obsidian";
import type DropboxSyncPlugin from "../main";
import {
  countEnabledBackgroundSections,
  getManualSyncToggleDefaults,
  sectionsFromToggles,
  type BackgroundSyncSections,
} from "../settings";
import { SYNC_SCOPE_LABELS, type VaultSection } from "../sync/sync-scope";

const SECTION_KEYS: VaultSection[] = ["notes", "settings", "plugins", "workspaces"];

export class SyncScopeModal extends Modal {
  private toggles: BackgroundSyncSections;
  private rowsEl: HTMLElement | null = null;
  private syncBtn: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private plugin: DropboxSyncPlugin,
  ) {
    super(app);
    this.toggles = getManualSyncToggleDefaults(plugin.settings);
  }

  onOpen(): void {
    const { contentEl } = this;
    const mobile = Platform.isMobile;
    this.modalEl.addClass(
      mobile ? "dbx-sync-scope-modal-mobile" : "dbx-sync-scope-modal",
    );

    contentEl.createEl("h3", { text: "Manual sync" });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Choose which sections to sync. Background-synced sections are off by default.",
    });
    this.rowsEl = contentEl.createEl("div", { cls: "dbx-sync-scope-rows" });
    this.renderScopeRows();

    const footer = contentEl.createEl("div", { cls: "dbx-sync-scope-footer" });
    this.syncBtn = footer.createEl("button", {
      cls: "mod-cta",
      text: "Sync",
    });
    this.syncBtn.addEventListener("click", () => this.startSync());
    this.updateSyncButton();
  }

  onClose(): void {
    this.plugin.onSyncScopeModalClosed();
    this.contentEl.empty();
  }

  private renderScopeRows(): void {
    if (!this.rowsEl) return;
    this.rowsEl.empty();

    for (const key of SECTION_KEYS) {
      new Setting(this.rowsEl)
        .setName(SYNC_SCOPE_LABELS[key])
        .addToggle((toggle) => {
          toggle.setValue(this.toggles[key]).onChange((value) => {
            if (!value && countEnabledBackgroundSections(this.toggles) <= 1 && this.toggles[key]) {
              new Notice("At least one section must be enabled.");
              toggle.setValue(true);
              return;
            }
            this.toggles = { ...this.toggles, [key]: value };
            this.updateSyncButton();
          });
        });
    }
  }

  private updateSyncButton(): void {
    if (!this.syncBtn) return;
    const enabled = sectionsFromToggles(this.toggles).length > 0;
    this.syncBtn.disabled = !enabled;
  }

  private startSync(): void {
    const sections = sectionsFromToggles(this.toggles);
    if (sections.length === 0) {
      new Notice("At least one section must be enabled.");
      return;
    }
    this.close();
    void this.plugin.syncNow({ manual: true, sections });
  }
}
