import { setIcon, type App, type WorkspaceLeaf } from "obsidian";
import { SYNC_SCOPE_LABELS, type VaultSection } from "../sync/sync-scope";

export type SectionProgressState = "pending" | "active" | "success" | "partial" | "failed";

export interface SectionProgressSegment {
  section: VaultSection;
  state: SectionProgressState;
  description: string;
  /** Plan operations finished in this section (execute phase). */
  completed: number;
  /** Plan operations total for this section; 0 until execute reports a total. */
  total: number;
}

/**
 * Sticky footer in the file explorer for manual sync section progress.
 * Stays visible after the run until the next manual sync replaces it (or unload).
 * Click the footer to minimize/restore detail text; chevron flips with state.
 * Active segments pulse and fill left-to-right from execute onProgress (completed/total).
 */
export class SyncSectionProgress {
  private rootEl: HTMLElement | null = null;
  private trackEl: HTMLElement | null = null;
  private detailEl: HTMLElement | null = null;
  private toggleBtn: HTMLElement | null = null;
  private isMinimized = false;
  private segments: SectionProgressSegment[] = [];
  private fillEls = new Map<VaultSection, HTMLElement>();
  private layoutHandler: (() => void) | null = null;

  constructor(private app: App) {}

  /** Show N segments for the selected sections (notes → settings → plugins → workspaces order). */
  show(sections: VaultSection[]): void {
    this.segments = sections.map((section) => ({
      section,
      state: "pending" as const,
      description: "Waiting…",
      completed: 0,
      total: 0,
    }));
    this.mount();
    this.render();
  }

  markActive(section: VaultSection): void {
    const seg = this.segments.find((s) => s.section === section);
    if (!seg) return;
    seg.state = "active";
    seg.description = "Syncing…";
    seg.completed = 0;
    seg.total = 0;
    this.render();
  }

  /** Show the segment as active before plan/execute (local+remote scan). */
  markScanning(section: VaultSection): void {
    const seg = this.segments.find((s) => s.section === section);
    if (!seg) return;
    seg.state = "active";
    seg.description = "Scanning changes…";
    seg.completed = 0;
    seg.total = 0;
    this.render();
  }

  /**
   * Update fill % from executor progress for the active section.
   * Prefer this over full re-render so concurrent ops can update often.
   */
  updateOperationProgress(section: VaultSection, completed: number, total: number): void {
    const seg = this.segments.find((s) => s.section === section);
    if (!seg || seg.state !== "active") return;
    seg.completed = completed;
    seg.total = total;
    if (total > 0) {
      seg.description = `Syncing… ${completed}/${total}`;
    }
    const fill = this.fillEls.get(section);
    if (fill) {
      fill.style.width = `${fillPercent(seg)}%`;
    }
    this.renderDetail();
  }

  markResult(section: VaultSection, state: Exclude<SectionProgressState, "pending" | "active">, description: string): void {
    const seg = this.segments.find((s) => s.section === section);
    if (!seg) return;
    seg.state = state;
    seg.description = description;
    // Finished segments show a full bar in their outcome color.
    if (seg.total <= 0) {
      seg.total = 1;
      seg.completed = 1;
    } else {
      seg.completed = seg.total;
    }
    this.render();
  }

  /** Mark the active/pending segment as failed and leave later ones as skipped. */
  markInterrupted(section: VaultSection | null, description: string): void {
    let hit = section === null;
    for (const seg of this.segments) {
      if (section && seg.section === section) {
        hit = true;
        if (seg.state === "pending" || seg.state === "active") {
          seg.state = "failed";
          seg.description = description;
        }
        continue;
      }
      if (hit && (seg.state === "pending" || seg.state === "active")) {
        seg.state = "failed";
        seg.description = "Skipped";
      }
    }
    this.render();
  }

  /** Hide and detach (also used on plugin unload). */
  destroy(): void {
    if (this.layoutHandler) {
      this.app.workspace.off("layout-change", this.layoutHandler);
      this.layoutHandler = null;
    }
    this.rootEl?.remove();
    this.rootEl = null;
    this.trackEl = null;
    this.detailEl = null;
    this.toggleBtn = null;
    this.isMinimized = false;
    this.fillEls.clear();
    this.segments = [];
  }

  /** Collapse detail lines while keeping title + segment bars visible. */
  private toggleMinimized(): void {
    this.isMinimized = !this.isMinimized;
    this.rootEl?.toggleClass("dbx-sync-explorer-progress-minimized", this.isMinimized);
    if (this.toggleBtn) {
      // Down = can minimize; up = can restore.
      setIcon(this.toggleBtn, this.isMinimized ? "chevron-up" : "chevron-down");
      this.toggleBtn.setAttr("aria-label", this.isMinimized ? "Expand" : "Minimize");
    }
  }

  private mount(): void {
    if (!this.rootEl) {
      this.rootEl = document.createElement("div");
      this.rootEl.addClass("dbx-sync-explorer-progress");
      // Whole footer toggles minimize — clearer than a Close control that stopped sync UI.
      this.rootEl.addEventListener("click", () => this.toggleMinimized());

      const header = this.rootEl.createDiv({ cls: "dbx-sync-explorer-progress-header" });
      header.createSpan({ text: "Sync", cls: "dbx-sync-explorer-progress-title" });
      this.toggleBtn = header.createEl("button", {
        cls: "dbx-sync-explorer-progress-toggle",
        attr: { type: "button", "aria-label": "Minimize" },
      });
      setIcon(this.toggleBtn, "chevron-down");

      this.trackEl = this.rootEl.createDiv({ cls: "dbx-sync-section-track" });
      this.detailEl = this.rootEl.createDiv({ cls: "dbx-sync-explorer-progress-detail" });

      if (!this.layoutHandler) {
        this.layoutHandler = () => this.attachToExplorers();
        this.app.workspace.on("layout-change", this.layoutHandler);
      }
    }
    this.attachToExplorers();
  }

  private attachToExplorers(): void {
    if (!this.rootEl) return;
    const leaves = this.app.workspace.getLeavesOfType("file-explorer");
    for (const leaf of leaves) {
      this.attachToLeaf(leaf);
    }
  }

  private attachToLeaf(leaf: WorkspaceLeaf): void {
    if (!this.rootEl) return;
    const container = (leaf.view as { containerEl?: HTMLElement }).containerEl;
    if (!container) return;
    // Keep a single shared footer; re-parent to the first visible explorer.
    if (this.rootEl.parentElement !== container) {
      container.appendChild(this.rootEl);
    }
  }

  private render(): void {
    if (!this.trackEl || !this.detailEl) return;
    this.trackEl.empty();
    this.fillEls.clear();
    for (const seg of this.segments) {
      const cell = this.trackEl.createDiv({
        cls: `dbx-sync-section-seg dbx-sync-section-seg-${seg.state}`,
        attr: { title: `${SYNC_SCOPE_LABELS[seg.section]}: ${seg.description}` },
      });
      // Track + fill: pulse stays on the fill while width reflects completed/total.
      const bar = cell.createDiv({ cls: "dbx-sync-section-seg-bar" });
      const fill = bar.createDiv({ cls: "dbx-sync-section-seg-fill" });
      fill.style.width = `${fillPercent(seg)}%`;
      this.fillEls.set(seg.section, fill);
      cell.createDiv({
        cls: "dbx-sync-section-seg-label",
        text: shortLabel(seg.section),
      });
    }
    this.renderDetail();
  }

  private renderDetail(): void {
    if (!this.detailEl) return;
    const lines = this.segments.map(
      (s) => `${SYNC_SCOPE_LABELS[s.section]}: ${s.description}`,
    );
    this.detailEl.setText(lines.join("\n"));
  }
}

/** Width % for the segment fill: pending empty, finished full, active by completed/total. */
function fillPercent(seg: SectionProgressSegment): number {
  if (seg.state === "pending") return 0;
  // Finished with no execute totals (e.g. empty plan) still show a complete bar.
  if (seg.state !== "active" && seg.total <= 0) return 100;
  if (seg.total <= 0) return 0;
  return Math.min(100, Math.round((seg.completed / seg.total) * 100));
}

function shortLabel(section: VaultSection): string {
  switch (section) {
    case "notes":
      return "Notes";
    case "settings":
      return "Settings";
    case "plugins":
      return "Plugins";
    case "workspaces":
      return "Workspaces";
  }
}

/** Map sync feedback outcome to a progress segment color state. */
export function outcomeToSectionState(
  outcome: string,
): Exclude<SectionProgressState, "pending" | "active"> {
  switch (outcome) {
    case "success":
    case "up_to_date":
    case "renamed_resync":
      return "success";
    case "partial":
      return "partial";
    case "failed":
    case "error":
    case "auth_error":
    case "aborted":
      return "failed";
    default:
      return "partial";
  }
}
