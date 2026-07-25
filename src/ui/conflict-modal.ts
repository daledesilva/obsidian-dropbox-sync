import { App, Modal, Platform, Setting } from "obsidian";
import type { ConflictContext } from "../types";
import { buildMergeSegments, assembleMerged, type ConflictSegment } from "./merge-segments";

export type ConflictChoice = "local" | "remote" | "skip" | MergedChoice;

export interface MergedChoice {
  type: "merged";
  content: Uint8Array;
}

export class ConflictModal extends Modal {
  private choice: ConflictChoice | null = null;
  private resolve: ((choice: ConflictChoice | null) => void) | null = null;

  constructor(
    app: App,
    private filePath: string,
    private context?: ConflictContext,
    private progress?: { index: number; total: number },
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, context } = this;
    const mobile = Platform.isMobile;

    this.modalEl.addClass(mobile ? "dbx-sync-conflict-modal-wide-mobile" : "dbx-sync-conflict-modal-wide");

    // Use the modal title bar — not an h3 inside the body.
    const title = this.progress && this.progress.total > 1
      ? `Sync Conflict (${this.progress.index}/${this.progress.total})`
      : "Sync Conflict";
    this.setTitle(title);
    contentEl.createEl("p", {
      text: `"${this.filePath}" was modified on both this device and Dropbox.`,
    });

    if (context?.localContent !== undefined && context?.remoteContent !== undefined) {
      this.renderMergeView(contentEl, context.localContent, context.remoteContent, mobile);
    } else if (context?.localData && context?.remoteData && this.isImage(this.filePath)) {
      this.renderImageCompare(contentEl, context.localData, context.remoteData, mobile);
      this.renderSimpleButtons(contentEl);
    } else if (context) {
      this.renderMetadata(contentEl, context);
      this.renderSimpleButtons(contentEl);
    } else {
      this.renderSimpleButtons(contentEl);
    }
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolve?.(this.choice);
  }

  waitForChoice(): Promise<ConflictChoice | null> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  // ── 텍스트 머지 뷰 (블록 선택) ──

  private renderMergeView(el: HTMLElement, local: string, remote: string, mobile: boolean): void {
    const segments = buildMergeSegments(local, remote);
    const conflictCount = segments.filter((s) => s.type === "conflict").length;

    if (conflictCount === 0) {
      el.createEl("p", {
        text: "No conflicts — changes are compatible and have been auto-merged.",
        cls: "setting-item-description",
      });
    } else {
      el.createEl("p", {
        text: `${conflictCount} section(s) differ between versions. Choose which to keep for each:`,
        cls: "setting-item-description",
      });
    }

    const scrollContainer = el.createDiv({
      cls: mobile ? "dbx-sync-conflict-scroll-mobile" : "dbx-sync-conflict-scroll",
    });

    let conflictIdx = 0;
    for (const seg of segments) {
      if (seg.type === "resolved") {
        this.renderResolvedBlock(scrollContainer, seg.lines);
      } else {
        conflictIdx++;
        this.renderConflictBlock(scrollContainer, seg, conflictIdx, conflictCount);
      }
    }

    // 상태 표시 + 저장 버튼
    const statusEl = el.createEl("p", { cls: "setting-item-description" });
    const updateStatus = () => {
      const unresolved = segments.filter(
        (s) => s.type === "conflict" && s.choice === null,
      ).length;
      if (unresolved > 0) {
        statusEl.textContent = `${unresolved} unresolved`;
        statusEl.removeClass("dbx-sync-conflict-status-resolved");
        statusEl.addClass("dbx-sync-conflict-status-unresolved");
      } else {
        statusEl.textContent = "All resolved";
        statusEl.removeClass("dbx-sync-conflict-status-unresolved");
        statusEl.addClass("dbx-sync-conflict-status-resolved");
      }
    };
    updateStatus();

    // 이벤트: 선택 변경 시 상태 갱신
    scrollContainer.addEventListener("conflict-resolved", () => updateStatus());

    const btnRow = new Setting(el);
    let saveBtnEl: HTMLButtonElement | null = null;

    btnRow
      .addButton((btn) => {
        btn
          .setButtonText("Save")
          .setCta()
          .onClick(() => {
            const merged = assembleMerged(segments);
            this.choice = {
              type: "merged",
              content: new TextEncoder().encode(merged),
            };
            this.close();
          });
        saveBtnEl = btn.buttonEl;
      })
      .addButton((btn) =>
        btn.setButtonText("Keep all local").onClick(() => {
          this.choice = "local";
          this.close();
        }),
      )
      .addButton((btn) =>
        btn.setButtonText("Keep all remote").onClick(() => {
          this.choice = "remote";
          this.close();
        }),
      )
      .addExtraButton((btn) =>
        btn.setIcon("clock").setTooltip("Later").onClick(() => {
          this.choice = "skip";
          this.close();
        }),
      );

    // Save 버튼에 미해결 경고 표시
    const updateSaveBtn = () => {
      if (!saveBtnEl) return;
      const unresolved = segments.filter(
        (s) => s.type === "conflict" && s.choice === null,
      ).length;
      if (unresolved > 0) {
        saveBtnEl.textContent = `Save (${unresolved} unresolved → local)`;
        saveBtnEl.title = `${unresolved} unresolved conflict(s) will default to local version`;
      } else {
        saveBtnEl.textContent = "Save";
        saveBtnEl.title = "";
      }
    };
    updateSaveBtn();
    scrollContainer.addEventListener("conflict-resolved", () => updateSaveBtn());
  }

  private renderResolvedBlock(parent: HTMLElement, lines: string[]): void {
    if (lines.length === 0) return;
    const block = parent.createDiv({ cls: "dbx-sync-conflict-resolved-block" });

    // 긴 동일 블록은 접기
    if (lines.length > 6) {
      const first = lines.slice(0, 2);
      const last = lines.slice(-2);
      block.createDiv({ text: first.join("\n") });
      const collapsed = block.createDiv({
        text: `  ... ${lines.length - 4} unchanged lines ...`,
        cls: "dbx-sync-conflict-collapsed-hint",
      });
      const rest = block.createDiv({ text: last.join("\n") });

      let expanded = false;
      collapsed.addEventListener("click", () => {
        if (expanded) {
          collapsed.textContent = `  ... ${lines.length - 4} unchanged lines ...`;
          rest.textContent = last.join("\n");
        } else {
          collapsed.textContent = "";
          rest.textContent = lines.slice(2).join("\n");
        }
        expanded = !expanded;
      });
    } else {
      block.textContent = lines.join("\n");
    }
  }

  private renderConflictBlock(
    parent: HTMLElement,
    seg: ConflictSegment,
    idx: number,
    total: number,
  ): void {
    const card = parent.createDiv({ cls: "dbx-sync-conflict-card" });

    // 헤더
    const header = card.createDiv({ cls: "dbx-sync-conflict-header" });
    header.textContent = `Conflict ${idx}/${total}`;

    const body = card.createDiv({ cls: "dbx-sync-conflict-body" });

    const hasLocal = seg.local.length > 0;
    const hasRemote = seg.remote.length > 0;
    const hasBoth = hasLocal && hasRemote;

    // Local 옵션
    const localRow = body.createDiv();
    const localLabel = hasRemote ? "Local" : "Local only (keep?)";
    localRow.createEl("span", {
      text: localLabel,
      cls: "setting-item-description dbx-sync-conflict-label-bold",
    });
    const localCode = localRow.createDiv({
      text: hasLocal ? seg.local.join("\n") : "(empty — remove these lines)",
      cls: `dbx-sync-conflict-code dbx-sync-conflict-code-local${hasLocal ? "" : " dbx-sync-conflict-code-empty"}`,
    });

    // Remote 옵션
    const remoteRow = body.createDiv();
    const remoteLabel = hasLocal ? "Remote" : "Remote only (include?)";
    remoteRow.createEl("span", {
      text: remoteLabel,
      cls: "setting-item-description dbx-sync-conflict-label-bold",
    });
    const remoteCode = remoteRow.createDiv({
      text: hasRemote ? seg.remote.join("\n") : "(empty — remove these lines)",
      cls: `dbx-sync-conflict-code dbx-sync-conflict-code-remote${hasRemote ? "" : " dbx-sync-conflict-code-empty"}`,
    });

    // Both 옵션 (양쪽 다 있을 때만)
    let bothCode: HTMLDivElement | null = null;
    if (hasBoth) {
      const bothRow = body.createDiv();
      bothRow.createEl("span", {
        text: "Both (local + remote)",
        cls: "setting-item-description dbx-sync-conflict-label-bold",
      });
      bothCode = bothRow.createDiv({
        text: [...seg.local, ...seg.remote].join("\n"),
        cls: "dbx-sync-conflict-code dbx-sync-conflict-code-both",
      });
    }

    const select = (choice: "local" | "remote" | "both") => {
      seg.choice = choice;
      localCode.removeClass("dbx-sync-conflict-code-selected-local");
      remoteCode.removeClass("dbx-sync-conflict-code-selected-remote");
      if (bothCode) bothCode.removeClass("dbx-sync-conflict-code-selected-both");
      if (choice === "local") localCode.addClass("dbx-sync-conflict-code-selected-local");
      if (choice === "remote") remoteCode.addClass("dbx-sync-conflict-code-selected-remote");
      if (choice === "both" && bothCode) bothCode.addClass("dbx-sync-conflict-code-selected-both");
      header.addClass("dbx-sync-conflict-header-resolved");
      header.textContent = `Conflict ${idx}/${total} — ${choice}`;
      card.addClass("dbx-sync-conflict-card-resolved");
      parent.dispatchEvent(new Event("conflict-resolved"));
    };

    localCode.addEventListener("click", () => select("local"));
    remoteCode.addEventListener("click", () => select("remote"));
    if (bothCode) bothCode.addEventListener("click", () => select("both"));
  }

  // ── 이미지 비교 ──

  private renderImageCompare(el: HTMLElement, localData: Uint8Array, remoteData: Uint8Array, mobile: boolean): void {
    const mime = this.guessMime(this.filePath);

    const imgCls = mobile ? "dbx-sync-conflict-img-preview-mobile" : "dbx-sync-conflict-img-preview";
    const container = el.createDiv({
      cls: mobile ? "dbx-sync-conflict-img-grid-mobile" : "dbx-sync-conflict-img-grid",
    });

    const localCol = container.createDiv();
    localCol.createEl("h4", { text: `Local (${this.formatSize(localData.length)})` });
    const localImg = localCol.createEl("img", { cls: imgCls });
    localImg.src = `data:${mime};base64,${uint8ToBase64(localData)}`;

    const remoteCol = container.createDiv();
    remoteCol.createEl("h4", { text: `Remote (${this.formatSize(remoteData.length)})` });
    const remoteImg = remoteCol.createEl("img", { cls: imgCls });
    remoteImg.src = `data:${mime};base64,${uint8ToBase64(remoteData)}`;
  }

  // ── 메타데이터 / 간단 버튼 ──

  private renderMetadata(el: HTMLElement, ctx: ConflictContext): void {
    const parts: string[] = [];
    if (ctx.localSize !== undefined) parts.push(`Local: ${this.formatSize(ctx.localSize)}`);
    if (ctx.remoteSize !== undefined) parts.push(`Remote: ${this.formatSize(ctx.remoteSize)}`);
    if (ctx.remoteMtime) parts.push(`Remote modified: ${new Date(ctx.remoteMtime).toLocaleString()}`);
    if (parts.length > 0) {
      el.createEl("p", { text: parts.join(" · "), cls: "setting-item-description" });
    }
  }

  private renderSimpleButtons(el: HTMLElement): void {
    new Setting(el)
      .addButton((btn) =>
        btn.setButtonText("Keep local").setCta().onClick(() => {
          this.choice = "local";
          this.close();
        }),
      )
      .addButton((btn) =>
        btn.setButtonText("Keep remote").onClick(() => {
          this.choice = "remote";
          this.close();
        }),
      )
      .addExtraButton((btn) =>
        btn.setIcon("clock").setTooltip("Later").onClick(() => {
          this.choice = "skip";
          this.close();
        }),
      );
  }

  // ── 유틸 ──

  private isImage(path: string): boolean {
    return /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(path);
  }

  private guessMime(path: string): string {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    const map: Record<string, string> = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
      gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
      bmp: "image/bmp", ico: "image/x-icon",
    };
    return map[ext] ?? "application/octet-stream";
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}

// re-export for external consumers
export { buildMergeSegments, computeLineDiff } from "./merge-segments";

function uint8ToBase64(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}
