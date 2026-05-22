import { App, Modal, Platform, Setting } from "obsidian";
import type DropboxSyncPlugin from "../main";
import {
  assessRemoteFiles,
  countForScope,
  emptyScopeCounts,
  SYNC_SCOPE_LABELS,
  type ScopeCounts,
  type SyncScope,
} from "../sync/sync-scope";

const SCOPES: SyncScope[] = ["everything", "notes", "settings", "plugins", "workspaces"];

export class SyncScopeModal extends Modal {
  private counts: ScopeCounts = emptyScopeCounts();
  private scanDone = false;
  private aborted = false;
  private statusEl: HTMLElement | null = null;
  private rowsEl: HTMLElement | null = null;

  constructor(
    app: App,
    private plugin: DropboxSyncPlugin,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    const mobile = Platform.isMobile;
    this.modalEl.addClass(
      mobile ? "dbx-sync-scope-modal-mobile" : "dbx-sync-scope-modal",
    );

    contentEl.createEl("h3", { text: "Choose what to sync" });
    this.statusEl = contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Scanning Dropbox…",
    });
    this.rowsEl = contentEl.createEl("div", { cls: "dbx-sync-scope-rows" });
    this.renderScopeRows(true);
    void this.runAssessment();
  }

  onClose(): void {
    this.aborted = true;
    this.plugin.onSyncScopeModalClosed();
    this.contentEl.empty();
  }

  private async runAssessment(): Promise<void> {
    const remote = this.plugin.getRemoteAdapter();
    if (!remote) {
      this.setStatus("Not connected to Dropbox. Open settings to connect.");
      this.scanDone = true;
      this.renderScopeRows(false);
      return;
    }

    try {
      this.counts = await assessRemoteFiles(
        remote,
        this.app.vault.configDir,
        this.plugin.settings.excludePatterns,
        {
          onProgress: (c) => {
            if (this.aborted) return;
            this.counts = { ...c };
            this.setStatus(`Scanning Dropbox… ${c.totalListed} files listed`);
            this.renderScopeRows(true);
          },
        },
      );
      if (this.aborted) return;
      this.scanDone = true;
      this.setStatus(
        `Found ${this.counts.totalListed} files on Dropbox (${this.counts.excluded} excluded by your patterns).`,
      );
      this.renderScopeRows(false);
    } catch (e) {
      if (this.aborted) return;
      const msg = e instanceof Error ? e.message : String(e);
      this.setStatus(`Scan failed: ${msg}`);
      this.scanDone = true;
      this.renderScopeRows(false);
    }
  }

  private setStatus(text: string): void {
    if (this.statusEl) this.statusEl.setText(text);
  }

  private renderScopeRows(disabled: boolean): void {
    if (!this.rowsEl) return;
    this.rowsEl.empty();

    for (const scope of SCOPES) {
      const n = countForScope(this.counts, scope);
      const btnText = this.scanDone ? `Sync (${n})` : "Sync (…)";

      new Setting(this.rowsEl)
        .setName(SYNC_SCOPE_LABELS[scope])
        .addButton((btn) => {
          btn
            .setButtonText(btnText)
            .setDisabled(disabled || (this.scanDone && n === 0 && scope !== "everything"))
            .onClick(() => this.startSync(scope));
          if (scope === "everything") btn.setCta();
        });
    }
  }

  private startSync(scope: SyncScope): void {
    this.close();
    void this.plugin.syncNow({ manual: true, scope });
  }
}
