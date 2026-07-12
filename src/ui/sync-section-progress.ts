import type { App, WorkspaceLeaf } from "obsidian";
import { SYNC_SCOPE_LABELS, type VaultSection } from "../sync/sync-scope";

export type SectionProgressState = "pending" | "active" | "success" | "partial" | "failed";

export interface SectionProgressSegment {
  section: VaultSection;
  state: SectionProgressState;
  description: string;
}

/**
 * Sticky footer in the file explorer for manual sync section progress.
 * Stays visible after the run until the user closes it so outcomes remain readable.
 */
export class SyncSectionProgress {
  private rootEl: HTMLElement | null = null;
  private trackEl: HTMLElement | null = null;
  private detailEl: HTMLElement | null = null;
  private segments: SectionProgressSegment[] = [];
  private layoutHandler: (() => void) | null = null;

  constructor(private app: App) {}

  /** Show N segments for the selected sections (notes → settings → plugins → workspaces order). */
  show(sections: VaultSection[]): void {
    this.segments = sections.map((section) => ({
      section,
      state: "pending" as const,
      description: "Waiting…",
    }));
    this.mount();
    this.render();
  }

  markActive(section: VaultSection): void {
    const seg = this.segments.find((s) => s.section === section);
    if (!seg) return;
    seg.state = "active";
    seg.description = "Syncing…";
    this.render();
  }

  markResult(section: VaultSection, state: Exclude<SectionProgressState, "pending" | "active">, description: string): void {
    const seg = this.segments.find((s) => s.section === section);
    if (!seg) return;
    seg.state = state;
    seg.description = description;
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
    this.segments = [];
  }

  private mount(): void {
    if (!this.rootEl) {
      this.rootEl = document.createElement("div");
      this.rootEl.addClass("dbx-sync-explorer-progress");

      const header = this.rootEl.createDiv({ cls: "dbx-sync-explorer-progress-header" });
      header.createSpan({ text: "Manual sync", cls: "dbx-sync-explorer-progress-title" });
      const closeBtn = header.createEl("button", {
        text: "Close",
        cls: "dbx-sync-explorer-progress-close",
      });
      closeBtn.addEventListener("click", () => this.destroy());

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
    for (const seg of this.segments) {
      const cell = this.trackEl.createDiv({
        cls: `dbx-sync-section-seg dbx-sync-section-seg-${seg.state}`,
        attr: { title: `${SYNC_SCOPE_LABELS[seg.section]}: ${seg.description}` },
      });
      cell.createDiv({ cls: "dbx-sync-section-seg-bar" });
      cell.createDiv({
        cls: "dbx-sync-section-seg-label",
        text: shortLabel(seg.section),
      });
    }

    const lines = this.segments.map(
      (s) => `${SYNC_SCOPE_LABELS[s.section]}: ${s.description}`,
    );
    this.detailEl.setText(lines.join("\n"));
  }
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
