import { App, Modal, Platform, Setting } from "obsidian";
import type { PathGuardIssue, PathIssueResolution } from "../types";
import { isPathValid, suggestFixedPath, summarizePathIssues } from "../sync/path-validator";

const DOCS_BASE = "https://github.com/zeakd/obsidian-dropbox-sync/blob/main/docs";

export interface IncompatiblePathsModalOptions {
  strictLocal: boolean;
}

interface RowState {
  issue: PathGuardIssue;
  inputEl: HTMLInputElement;
  errorEl: HTMLElement;
}

/**
 * 호환되지 않는 파일 경로를 한 모달에서 수정하거나 스킵한다.
 */
export class IncompatiblePathsModal extends Modal {
  private rows: RowState[] = [];
  private resolve: ((result: PathIssueResolution) => void) | null = null;
  private listEl: HTMLElement | null = null;
  private settled = false;

  constructor(
    app: App,
    private issues: PathGuardIssue[],
    private options: IncompatiblePathsModalOptions,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    const mobile = Platform.isMobile;
    this.modalEl.addClass(
      mobile ? "dbx-sync-path-modal-wide-mobile" : "dbx-sync-path-modal-wide",
    );

    contentEl.createEl("h3", { text: "Fix incompatible file names" });
    contentEl.createEl("p", {
      text: "Some files use names that Dropbox allows but this device cannot create (often from Windows). Rename them below, or skip to sync everything else.",
    });

    const hint = contentEl.createEl("p", { cls: "setting-item-description" });
    hint.setText(
      this.options.strictLocal
        ? "Avoid : * ? \" < > | in names, trailing spaces or dots, and reserved names like CON."
        : "These paths violate sync naming rules.",
    );

    this.listEl = contentEl.createEl("div", {
      cls: mobile ? "dbx-sync-path-list-mobile" : "dbx-sync-path-list",
    });

    for (const issue of this.issues) {
      this.addRow(this.listEl, issue);
    }

    const actions = contentEl.createEl("div", { cls: "dbx-sync-path-actions" });
    new Setting(actions)
      .addButton((btn) =>
        btn.setButtonText("Apply recommended to all").onClick(() => this.applyRecommendedToAll()),
      )
      .addButton((btn) =>
        btn
          .setButtonText("Apply renames & sync")
          .setCta()
          .onClick(() => this.submitRenames()),
      )
      .addButton((btn) =>
        btn.setButtonText("Skip these files").onClick(() => {
          this.finish({ action: "skip" });
        }),
      );

    const linkFrag = document.createDocumentFragment();
    linkFrag.appendText("Renames apply on Dropbox and in this vault when the file exists. ");
    const link = linkFrag.createEl("a", {
      text: "Learn more",
      href: `${DOCS_BASE}/troubleshooting.md`,
    });
    link.setAttr("target", "_blank");
    contentEl.createEl("p", { cls: "setting-item-description" }).appendChild(linkFrag);
  }

  private addRow(container: HTMLElement, issue: PathGuardIssue): void {
    const row = container.createEl("div", { cls: "dbx-sync-path-row" });

    const actionLabel =
      issue.item.action.type === "download"
        ? "download"
        : issue.item.action.type === "upload"
          ? "upload"
          : issue.item.action.type;

    row.createEl("div", {
      cls: "dbx-sync-path-original",
      text: issue.item.localPath,
    });
    row.createEl("div", {
      cls: "setting-item-description",
      text: `${actionLabel}: ${summarizePathIssues(issue.issues)}`,
    });

    const errorEl = row.createEl("div", { cls: "dbx-sync-path-error mod-warning" });
    errorEl.hide();

    const inputEl = row.createEl("input", {
      type: "text",
      cls: "dbx-sync-path-input",
      attr: { spellcheck: "false" },
    });
    inputEl.value = issue.suggestedPath;
    inputEl.addEventListener("input", () => {
      errorEl.hide();
    });

    this.rows.push({ issue, inputEl, errorEl });
  }

  private applyRecommendedToAll(): void {
    for (const row of this.rows) {
      row.inputEl.value = suggestFixedPath(row.issue.item.localPath);
      row.errorEl.hide();
    }
  }

  private submitRenames(): void {
    const renames: { from: string; to: string }[] = [];
    const used = new Set<string>();
    let valid = true;

    for (const row of this.rows) {
      const from = row.issue.item.localPath;
      const to = row.inputEl.value.trim();

      if (!to) {
        row.errorEl.setText("Name cannot be empty.");
        row.errorEl.show();
        valid = false;
        continue;
      }

      if (to === from) {
        row.errorEl.setText("Enter a different name or use Skip.");
        row.errorEl.show();
        valid = false;
        continue;
      }

      if (!isPathValid(to, this.options.strictLocal)) {
        row.errorEl.setText("This name is still not valid on this device.");
        row.errorEl.show();
        valid = false;
        continue;
      }

      const key = to.toLowerCase();
      if (used.has(key)) {
        row.errorEl.setText("Duplicate target name in this list.");
        row.errorEl.show();
        valid = false;
        continue;
      }
      used.add(key);

      row.errorEl.hide();
      renames.push({ from, to });
    }

    if (!valid) return;

    this.finish({ action: "renamed", renames });
  }

  private finish(result: PathIssueResolution): void {
    this.settled = true;
    const r = this.resolve;
    this.resolve = null;
    this.close();
    r?.(result);
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled && this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r({ action: "skip" });
    }
  }

  waitForResolution(): Promise<PathIssueResolution> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }
}
