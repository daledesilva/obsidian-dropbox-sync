import { Notice, setIcon, type App, type WorkspaceLeaf } from "obsidian";
import {
  ACTION_SUMMARY_SEPARATOR,
  actionSummaryModalTitle,
  formatActionSummaryPart,
  formatActionSummaryValue,
  type ActionSummaryPart,
  type ActionSummaryPaths,
  type ActionSummaryType,
} from "../sync/sync-reporter";
import type { VaultSection } from "../sync/sync-scope";
import { ActionPathsModal } from "./action-paths-modal";
import { SyncCancelConfirmModal } from "./sync-cancel-confirm-modal";

export type SectionProgressState = "pending" | "active" | "success" | "partial" | "failed";

export type SectionProgressPhase = "idle" | "scan" | "sync";

/** Vault section bars plus the trailing deferred-deletes segment. */
export type ProgressSegmentId = VaultSection | "deletions";

export interface SectionProgressSegment {
  section: ProgressSegmentId;
  state: SectionProgressState;
  description: string;
  /** scan = local list/hash; sync = plan execute. Drives detail copy for counts. */
  phase: SectionProgressPhase;
  /** Files/ops finished in the current phase. */
  completed: number;
  /** Known total for the current phase; 0 (or scan phase) means indeterminate (~5% fill). */
  total: number;
  /**
   * Newest-first paths for the active phase (up to 3).
   * Populated from scan/execute activity so the count link can peek at recent work.
   */
  recentPaths: string[];
  /** Succeeded conflict paths — retained for callers; chips use summaryPaths. */
  conflictPaths: string[];
  /** Structured action counts for white icons + normal-coloured values in the panel. */
  summaryParts: ActionSummaryPart[];
  /** Succeeded paths per action type — opened by summary chips. */
  summaryPaths: ActionSummaryPaths;
}

export interface SectionProgressResultOptions {
  conflictPaths?: string[];
  summaryParts?: ActionSummaryPart[];
  summaryPaths?: ActionSummaryPaths;
}

/**
 * True when at least one file-explorer leaf is laid out and visible.
 * Collapsed sidebars / no explorer leaf → false (segment Notices should fill in).
 */
export function isFileExplorerVisible(app: App): boolean {
  const leaves = app.workspace.getLeavesOfType("file-explorer");
  for (const leaf of leaves) {
    const el = (leaf.view as { containerEl?: HTMLElement }).containerEl;
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return true;
  }
  return false;
}

/**
 * Sticky footer in the file explorer for manual sync section progress.
 * Stays visible after the run until the next manual sync replaces it (or unload).
 * While syncing: click the title bar or progress track to minimize/restore; decorative
 * chevron flips with state. Detail and Cancel are not minimize targets.
 * When complete: auto-expands, title becomes "Sync completed", chevron becomes a plain X
 * that closes the panel.
 * Active segments pulse the whole track (grey + accent). Scan / unknown-total stay at ~5%
 * fill; execute progress grows left-to-right once a total is known.
 * Expanded detail uses short labels (Files/Settings/Plugins); an active count is an
 * accent-colored link that toggles a peek at the latest paths (up to 3, oldest→newest
 * top-to-bottom, older rows faded). Once opened, the peek follows onto later active
 * segments until collapsed. Count clicks use detailEl delegation so live number
 * re-renders do not drop the hit target.
 * Finished summaries use accent chips (upload/download/deletes/conflicts); chip click
 * opens a path-list modal. The Deletions detail text line is omitted when not actively
 * deleting (counts already appear as trash chips on vault-section lines).
 * Expanded footer: accent-styled Cancel (centered); the Cancel row collapses when complete.
 */
export class SyncSectionProgress {
  private rootEl: HTMLElement | null = null;
  private trackEl: HTMLElement | null = null;
  private detailEl: HTMLElement | null = null;
  private infoRowEl: HTMLElement | null = null;
  private cancelBtnEl: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  /**
   * Header trailing icon: decorative chevron while running; clickable plain X when complete.
   * Not a <button> — avoids theme button chrome.
   */
  private headerActionEl: HTMLElement | null = null;
  private isMinimized = false;
  private segments: SectionProgressSegment[] = [];
  private fillEls = new Map<ProgressSegmentId, HTMLElement>();
  /** Live `completed/total` text nodes — updated in place so the count link stays clickable. */
  private countTextEls = new Map<ProgressSegmentId, HTMLElement>();
  private layoutHandler: (() => void) | null = null;
  /**
   * When true for this run, emit Notices for segment start/end because the explorer
   * was closed at show() (or later checks find it closed).
   */
  private segmentNoticesEnabled = false;
  /** Pending end message to combine with the next segment start into one Notice. */
  private pendingEndedNotice: string | null = null;
  /** Section whose recent-path peek is open under its detail count link. */
  private recentPathsExpandedSection: ProgressSegmentId | null = null;
  /**
   * When the user opens the recent-path peek, keep showing it on later active segments
   * until they collapse it (or the run ends / is interrupted).
   */
  private recentPathsFollowActive = false;

  /**
   * @param onCancel Confirmed cancel from the panel — typically aborts the in-flight sync.
   */
  constructor(
    private app: App,
    private onCancel: () => void,
  ) {}

  /** Show N segments for the selected sections (files → settings → plugins → workspaces order). */
  show(sections: VaultSection[]): void {
    this.segments = sections.map((section) => ({
      section,
      state: "pending" as const,
      description: "Queued…",
      phase: "idle" as const,
      completed: 0,
      total: 0,
      recentPaths: [],
      conflictPaths: [],
      summaryParts: [],
      summaryPaths: {},
    }));
    // Sticky for the run: closed at start keeps Notices even if the user opens explorer later.
    this.segmentNoticesEnabled = !isFileExplorerVisible(this.app);
    this.pendingEndedNotice = null;
    this.recentPathsExpandedSection = null;
    this.recentPathsFollowActive = false;
    this.mount();
    this.render();
  }

  /**
   * Notify when a segment ends and/or the next starts. Combines end+start into one Notice
   * when both are provided (explorer closed / was closed at start).
   */
  notifySegmentTransition(ended: string | null, started: string | null): void {
    if (!this.shouldEmitSegmentNotices()) return;
    if (ended && started) {
      new Notice(`Dropbox Sync: ${ended} → ${started}`, 5000);
      this.pendingEndedNotice = null;
      return;
    }
    if (ended && !started) {
      // Hold until the next start so end+start can combine; flush on finishSegmentNotices.
      this.pendingEndedNotice = ended;
      return;
    }
    if (started) {
      if (this.pendingEndedNotice) {
        new Notice(`Dropbox Sync: ${this.pendingEndedNotice} → ${started}`, 5000);
        this.pendingEndedNotice = null;
      } else {
        new Notice(`Dropbox Sync: ${started}`, 4000);
      }
    }
  }

  /** Flush a held end Notice at the end of the interactive run. */
  finishSegmentNotices(): void {
    if (!this.shouldEmitSegmentNotices()) {
      this.pendingEndedNotice = null;
      return;
    }
    if (this.pendingEndedNotice) {
      new Notice(`Dropbox Sync: ${this.pendingEndedNotice}`, 5000);
      this.pendingEndedNotice = null;
    }
  }

  private shouldEmitSegmentNotices(): boolean {
    return this.segmentNoticesEnabled || !isFileExplorerVisible(this.app);
  }

  /**
   * Append a trailing Deletions bar once deletes are known during a manual run.
   * Idempotent — later sections that also have deletes do not add another cell.
   */
  ensureDeletionsSegment(): void {
    if (this.segments.some((s) => s.section === "deletions")) return;
    this.segments.push({
      section: "deletions",
      state: "pending",
      description: "Queued…",
      phase: "idle",
      completed: 0,
      total: 0,
      recentPaths: [],
      conflictPaths: [],
      summaryParts: [],
      summaryPaths: {},
    });
    this.render();
  }

  markActive(section: ProgressSegmentId): void {
    const seg = this.segments.find((s) => s.section === section);
    if (!seg) return;
    seg.state = "active";
    seg.phase = "sync";
    seg.description = section === "deletions" ? "Deleting…" : "Syncing…";
    // Reset counts so scan totals do not leak into execute fill until onProgress.
    seg.completed = 0;
    seg.total = 0;
    // Fresh execute phase — do not keep scan paths in the peek list.
    seg.recentPaths = [];
    // If the user had the path peek open on the previous segment, follow onto this one.
    this.adoptRecentPathsPeekForActiveSection(section);
    this.render();
  }

  /** Show the segment as active before plan/execute (local+remote scan). */
  markScanning(section: ProgressSegmentId): void {
    const seg = this.segments.find((s) => s.section === section);
    if (!seg) return;
    seg.state = "active";
    seg.phase = "scan";
    seg.description = "Scanning changes…";
    seg.completed = 0;
    seg.total = 0;
    seg.recentPaths = [];
    // Carry an open path peek onto the newly active segment (user opted in by expanding).
    this.adoptRecentPathsPeekForActiveSection(section);
    this.render();
  }

  /**
   * Update fill % for the active section (local scan or execute).
   * Prefer in-place fill + count text updates so the count-link hit target is not destroyed
   * while numbers tick (avoids dropped clicks during live re-renders).
   */
  updateOperationProgress(section: ProgressSegmentId, completed: number, total: number): void {
    const seg = this.segments.find((s) => s.section === section);
    if (!seg || seg.state !== "active") return;
    const hadCountLink = seg.total > 0;
    seg.completed = completed;
    seg.total = total;
    if (total > 0) {
      // Count-only description: the UI renders completed/total as the accent link.
      seg.description = `${completed}/${total}`;
    }
    const fill = this.fillEls.get(section);
    if (fill) {
      fill.style.width = `${fillPercent(seg)}%`;
    }
    const countText = this.countTextEls.get(section);
    if (countText && total > 0) {
      countText.setText(`${completed}/${total}`);
      return;
    }
    // First time a total appears (or count host missing) — build the accent link once.
    if (total > 0 && !hadCountLink) {
      this.renderDetail();
    }
  }

  /**
   * Record a path the active section is currently working on (scan hash or execute start).
   * Keeps newest-first latest paths (up to 3) for the detail count-link peek.
   */
  recordActivityPath(section: ProgressSegmentId, path: string): void {
    const seg = this.segments.find((s) => s.section === section);
    if (!seg || seg.state !== "active") return;
    const trimmed = path.trim();
    if (!trimmed) return;
    // Skip consecutive duplicates from rapid progress callbacks on the same file.
    if (seg.recentPaths[0] === trimmed) return;
    seg.recentPaths = [trimmed, ...seg.recentPaths].slice(0, RECENT_PATH_LIMIT);
    // Refresh only the peek list — leave the count link node intact for clicks.
    if (this.recentPathsExpandedSection === section) {
      this.renderRecentPathsPeek(section);
    }
  }

  markResult(
    section: ProgressSegmentId,
    state: Exclude<SectionProgressState, "pending" | "active">,
    description: string,
    options?: SectionProgressResultOptions,
  ): void {
    const seg = this.segments.find((s) => s.section === section);
    if (!seg) return;
    seg.state = state;
    seg.description = description;
    seg.conflictPaths = options?.conflictPaths ? [...options.conflictPaths] : [];
    seg.summaryParts = options?.summaryParts ? [...options.summaryParts] : [];
    seg.summaryPaths = options?.summaryPaths
      ? cloneSummaryPaths(options.summaryPaths)
      : {};
    // Finished segments show a full bar in their outcome color.
    if (seg.total <= 0) {
      seg.total = 1;
      seg.completed = 1;
    } else {
      seg.completed = seg.total;
    }
    // Count link goes away with active state — clear this section's peek host.
    // Keep recentPathsFollowActive so the next markScanning/markActive can reopen it.
    if (this.recentPathsExpandedSection === section) {
      this.recentPathsExpandedSection = null;
    }
    this.render();
  }

  /**
   * Patch a finished vault-section detail line after deferred deletes run.
   * Trash chips/paths appear only once deletes have actually succeeded.
   */
  updateSummaryParts(
    section: VaultSection,
    summaryParts: ActionSummaryPart[],
    description?: string,
    summaryPaths?: ActionSummaryPaths,
  ): void {
    const seg = this.segments.find((s) => s.section === section);
    if (!seg) return;
    seg.summaryParts = [...summaryParts];
    if (summaryPaths) {
      seg.summaryPaths = cloneSummaryPaths(summaryPaths);
      seg.conflictPaths = [...(summaryPaths.conflict ?? [])];
    }
    if (description !== undefined) {
      seg.description = description;
    } else if (summaryParts.length > 0) {
      seg.description = summaryParts
        .map(formatActionSummaryPart)
        .join(ACTION_SUMMARY_SEPARATOR);
    }
    this.render();
  }

  /** Mark the active/pending segment as failed and leave later ones as skipped. */
  markInterrupted(section: ProgressSegmentId | null, description: string): void {
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
    this.recentPathsExpandedSection = null;
    this.recentPathsFollowActive = false;
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
    this.infoRowEl = null;
    this.cancelBtnEl = null;
    this.titleEl = null;
    this.headerActionEl = null;
    this.isMinimized = false;
    this.segmentNoticesEnabled = false;
    this.pendingEndedNotice = null;
    this.recentPathsExpandedSection = null;
    this.recentPathsFollowActive = false;
    this.fillEls.clear();
    this.countTextEls.clear();
    this.segments = [];
  }

  /** Confirm cancel in a modal, then invoke the plugin abort callback. */
  private async requestCancel(): Promise<void> {
    if (this.isRunComplete()) return;
    const shouldCancel = await new SyncCancelConfirmModal(this.app).waitForConfirmation();
    if (shouldCancel) {
      this.onCancel();
    }
  }

  /** Toggle the recent-path peek under a section's accent count link. */
  private toggleRecentPaths(section: ProgressSegmentId): void {
    this.recentPathsExpandedSection =
      this.recentPathsExpandedSection === section ? null : section;
    // Opening opts into following the active segment; collapsing opts out.
    this.recentPathsFollowActive = this.recentPathsExpandedSection !== null;
    this.renderDetail();
  }

  /**
   * If the user already expanded the path peek this run, pin it to the newly active
   * section so segment transitions keep showing live files without another tap.
   */
  private adoptRecentPathsPeekForActiveSection(section: ProgressSegmentId): void {
    if (!this.recentPathsFollowActive) return;
    this.recentPathsExpandedSection = section;
  }

  /** Open the path-list modal for one finished summary chip. */
  private openSummaryChipModal(
    section: ProgressSegmentId,
    actionType: ActionSummaryType,
  ): void {
    const seg = this.segments.find((s) => s.section === section);
    if (!seg) return;
    const paths = seg.summaryPaths[actionType] ?? [];
    if (paths.length === 0) return;
    new ActionPathsModal(this.app, actionSummaryModalTitle(actionType), paths).open();
  }

  /** True when no segment is still pending or active. */
  private isRunComplete(): boolean {
    return (
      this.segments.length > 0
      && !this.segments.some((seg) => seg.state === "pending" || seg.state === "active")
    );
  }

  /** Collapse detail lines while keeping title + segment bars visible (running only). */
  private toggleMinimized(): void {
    if (this.isRunComplete()) return;
    this.isMinimized = !this.isMinimized;
    this.rootEl?.toggleClass("dbx-sync-explorer-progress-minimized", this.isMinimized);
    this.refreshHeaderAction();
  }

  private expandPanel(): void {
    this.isMinimized = false;
    this.rootEl?.removeClass("dbx-sync-explorer-progress-minimized");
    this.refreshHeaderAction();
  }

  /**
   * Title + trailing icon + click affordances.
   * Running: Syncing... + decorative chevron; title bar / progress track toggle minimize.
   * Complete: Sync completed + plain X closes the panel.
   */
  private refreshChrome(): void {
    const isComplete = this.isRunComplete();
    if (this.titleEl) {
      this.titleEl.setText(isComplete ? "Sync completed" : "Syncing...");
    }
    this.rootEl?.toggleClass("dbx-sync-explorer-progress-complete", isComplete);
    // Cancel only while a run is in progress — hide the whole row so min-height collapses.
    this.cancelBtnEl?.toggleClass("dbx-sync-explorer-progress-cancel-hidden", isComplete);
    this.infoRowEl?.toggleClass("dbx-sync-explorer-progress-info-row-hidden", isComplete);
    if (isComplete && this.isMinimized) {
      // Always show the finished summary; dismiss is only via the X.
      this.expandPanel();
      return;
    }
    this.refreshHeaderAction();
  }

  private refreshHeaderAction(): void {
    if (!this.headerActionEl) return;
    if (this.isRunComplete()) {
      setIcon(this.headerActionEl, "x");
      this.headerActionEl.setAttr("aria-label", "Close");
      // Obsidian HTMLElement has setAttr but not removeAttr — use DOM removeAttribute.
      this.headerActionEl.removeAttribute("aria-hidden");
      return;
    }
    // Down = can minimize; up = can restore. Decorative while running.
    setIcon(this.headerActionEl, this.isMinimized ? "chevron-up" : "chevron-down");
    this.headerActionEl.setAttr("aria-hidden", "true");
    this.headerActionEl.removeAttribute("aria-label");
  }

  /** While running, title bar / progress track toggle minimize; ignored when complete. */
  private handleChromeToggleClick(event: MouseEvent): void {
    if (this.isRunComplete()) return;
    event.preventDefault();
    event.stopPropagation();
    this.toggleMinimized();
  }

  private mount(): void {
    if (!this.rootEl) {
      this.rootEl = document.createElement("div");
      this.rootEl.addClass("dbx-sync-explorer-progress");

      const header = this.rootEl.createDiv({ cls: "dbx-sync-explorer-progress-header" });
      // Only header + progress track minimize/restore — not the detail/Cancel area.
      header.addEventListener("click", (event) => this.handleChromeToggleClick(event));
      this.titleEl = header.createSpan({
        text: "Syncing...",
        cls: "dbx-sync-explorer-progress-title",
      });
      // Span + icon only — not a <button>, so themes do not paint a control chrome.
      this.headerActionEl = header.createSpan({
        cls: "dbx-sync-explorer-progress-toggle",
        attr: { "aria-hidden": "true" },
      });
      setIcon(this.headerActionEl, "chevron-down");
      this.headerActionEl.addEventListener("click", (event) => {
        // Only the completed-state X is interactive; ignore while it's a decorative chevron.
        if (!this.isRunComplete()) return;
        event.preventDefault();
        event.stopPropagation();
        this.destroy();
      });

      this.trackEl = this.rootEl.createDiv({ cls: "dbx-sync-section-track" });
      this.trackEl.addEventListener("click", (event) => this.handleChromeToggleClick(event));
      this.detailEl = this.rootEl.createDiv({ cls: "dbx-sync-explorer-progress-detail" });
      // Delegate count/conflict toggles on the stable detail host so live number re-renders
      // (which only rewrite text inside the link) cannot drop the click handler mid-press.
      this.detailEl.addEventListener("pointerdown", (event) => {
        this.handleDetailPointerDown(event);
      });
      // Keep hash links from navigating; detail is no longer a minimize target.
      this.detailEl.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (
          target.closest(".dbx-sync-explorer-progress-count-link")
          || target.closest(".dbx-sync-explorer-progress-summary-chip")
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      });

      // Bottom of expanded panel: centered Cancel — not a minimize target.
      this.infoRowEl = this.rootEl.createDiv({ cls: "dbx-sync-explorer-progress-info-row" });
      this.cancelBtnEl = this.infoRowEl.createSpan({
        // Ellipsis signals the confirm modal — not an immediate abort.
        text: "Cancel sync...",
        cls: "dbx-sync-explorer-progress-cancel",
        attr: {
          role: "button",
          tabindex: "0",
          "aria-label": "Cancel sync",
        },
      });
      this.cancelBtnEl.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.requestCancel();
      });
      this.cancelBtnEl.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        void this.requestCancel();
      });

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
    this.refreshChrome();
    this.trackEl.empty();
    this.fillEls.clear();
    for (const seg of this.segments) {
      const cell = this.trackEl.createDiv({
        cls: `dbx-sync-section-seg dbx-sync-section-seg-${seg.state}`,
        attr: { title: `${shortLabel(seg.section)}: ${seg.description}` },
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

  /**
   * Count / chip clicks live on detailEl (not on the ticking number text) so progress
   * re-renders cannot replace the listener mid-press. pointerdown fires before the next
   * paint tick that might rewrite the count string.
   */
  private handleDetailPointerDown(event: PointerEvent): void {
    const target = event.target;
    if (!(target instanceof Element) || !this.detailEl) return;

    const countLink = target.closest(".dbx-sync-explorer-progress-count-link");
    if (countLink instanceof HTMLElement && this.detailEl.contains(countLink)) {
      const section = countLink.dataset.section as ProgressSegmentId | undefined;
      if (!section) return;
      event.preventDefault();
      event.stopPropagation();
      this.toggleRecentPaths(section);
      return;
    }

    const summaryChip = target.closest(".dbx-sync-explorer-progress-summary-chip");
    if (summaryChip instanceof HTMLElement && this.detailEl.contains(summaryChip)) {
      const section = summaryChip.dataset.section as ProgressSegmentId | undefined;
      const actionType = summaryChip.dataset.actionType as ActionSummaryType | undefined;
      if (!section || !actionType) return;
      event.preventDefault();
      event.stopPropagation();
      this.openSummaryChipModal(section, actionType);
    }
  }

  private renderDetail(): void {
    if (!this.detailEl) return;
    this.detailEl.empty();
    this.countTextEls.clear();
    for (const seg of this.segments) {
      // Deletions counts already appear as trash chips on vault-section lines —
      // only show this detail line while the trailing delete phase is active.
      if (seg.section === "deletions" && seg.state !== "active") {
        continue;
      }

      const line = this.detailEl.createDiv({
        cls: "dbx-sync-explorer-progress-detail-line",
        attr: { "data-section": seg.section },
      });
      // Section name stays faint so the value/icons after it read as the primary info.
      line.createSpan({
        text: `${shortLabel(seg.section)}: `,
        cls: "dbx-sync-explorer-progress-section-label",
      });

      // Active with a known total: accent count link toggles the recent-path peek.
      // Avoids "Syncing…" clutter and keeps the minimize click on the footer chrome.
      if (seg.state === "active" && seg.total > 0) {
        // Stable <a> host + child text: progress ticks only rewrite the child.
        const countLink = line.createEl("a", {
          cls: "dbx-sync-explorer-progress-count-link",
          href: "#",
          attr: {
            "data-section": seg.section,
            "aria-expanded": String(this.recentPathsExpandedSection === seg.section),
            "aria-label": "Show recent files",
          },
        });
        const countText = countLink.createSpan({
          text: `${seg.completed}/${seg.total}`,
        });
        this.countTextEls.set(seg.section, countText);
      } else if (seg.state === "pending") {
        line.createSpan({
          text: seg.description,
          cls: "dbx-sync-explorer-progress-queued",
        });
      } else {
        this.renderFinishedDescription(line, seg);
      }

      if (this.recentPathsExpandedSection === seg.section) {
        this.appendRecentPathsPeek(this.detailEl, seg);
      }
    }
  }

  /**
   * Rebuild only the open recent-path peek for a section (oldest→newest, bottom = newest).
   * Leaves the count-link host alone so live path updates do not steal clicks.
   */
  private renderRecentPathsPeek(section: ProgressSegmentId): void {
    if (!this.detailEl) return;
    const seg = this.segments.find((s) => s.section === section);
    if (!seg) return;
    const existing = this.detailEl.querySelector(
      `.dbx-sync-explorer-progress-recent[data-section="${section}"]`,
    );
    existing?.remove();
    if (this.recentPathsExpandedSection !== section) return;

    const line = this.detailEl.querySelector(
      `.dbx-sync-explorer-progress-detail-line[data-section="${section}"]`,
    );
    if (!(line instanceof HTMLElement)) {
      this.renderDetail();
      return;
    }
    const peek = this.appendRecentPathsPeek(this.detailEl, seg);
    // Keep peek directly under this section's summary line.
    line.insertAdjacentElement("afterend", peek);
  }

  /** Create the peek list: up to 3 paths, oldest on top / newest at bottom, older rows faded. */
  private appendRecentPathsPeek(
    parent: HTMLElement,
    seg: SectionProgressSegment,
  ): HTMLElement {
    const peek = parent.createDiv({
      cls: "dbx-sync-explorer-progress-recent",
      attr: { "data-section": seg.section },
    });
    if (seg.recentPaths.length === 0) {
      peek.createDiv({
        cls: "dbx-sync-explorer-progress-recent-empty",
        text: "No files yet…",
      });
      return peek;
    }
    // Storage is newest-first; reverse so the bottom row is the current file.
    const displayPaths = [...seg.recentPaths].reverse();
    const pathCount = displayPaths.length;
    displayPaths.forEach((path, displayIndex) => {
      const pathEl = peek.createDiv({
        cls: "dbx-sync-explorer-progress-recent-path",
      });
      // Dir truncates from the start; file name stays visible and bright.
      appendSplitPath(pathEl, path);
      // Newest (bottom) full opacity; the older two above are much more faded.
      pathEl.style.opacity = String(recentPathOpacity(displayIndex, pathCount));
    });
    return peek;
  }

  /**
   * Finished-line copy: accent chips (icons + count). Chip click opens a path modal.
   * Trailing prose after the parts string (e.g. skipped counts) stays as plain text.
   */
  private renderFinishedDescription(line: HTMLElement, seg: SectionProgressSegment): void {
    if (seg.summaryParts.length === 0) {
      line.createSpan({ text: seg.description });
      return;
    }

    const partsSummary = seg.summaryParts
      .map(formatActionSummaryPart)
      .join(ACTION_SUMMARY_SEPARATOR);
    let trailing = "";
    if (seg.description.startsWith(partsSummary)) {
      trailing = seg.description.slice(partsSummary.length);
    }

    const chips = line.createDiv({ cls: "dbx-sync-explorer-progress-summary-chips" });
    for (const part of seg.summaryParts) {
      const paths = seg.summaryPaths[part.type] ?? [];
      const chip = chips.createEl("a", {
        cls: "dbx-sync-explorer-progress-summary-chip",
        href: "#",
        attr: {
          "data-section": seg.section,
          "data-action-type": part.type,
          role: "button",
          "aria-label": `${actionSummaryModalTitle(part.type)} (${part.count})`,
        },
      });
      // Chips without paths stay non-interactive (should not happen for counted parts).
      if (paths.length === 0) {
        chip.addClass("dbx-sync-explorer-progress-summary-chip-disabled");
        chip.setAttr("aria-disabled", "true");
      }
      appendSummaryIcons(chip, part.type);
      chip.createSpan({
        text: formatActionSummaryValue(part),
        cls: "dbx-sync-explorer-progress-summary-value",
      });
    }

    if (trailing) {
      line.createSpan({ text: trailing });
    }
  }
}

/** Shallow-clone path arrays so segment state is not shared with caller maps. */
function cloneSummaryPaths(paths: ActionSummaryPaths): ActionSummaryPaths {
  const cloned: ActionSummaryPaths = {};
  for (const [type, list] of Object.entries(paths) as [ActionSummaryType, string[] | undefined][]) {
    if (list && list.length > 0) cloned[type] = [...list];
  }
  return cloned;
}

/** Lucide icons for panel summary — CSS forces pure white (emoji cannot). */
function appendSummaryIcons(parent: HTMLElement, type: ActionSummaryType): void {
  const wrap = parent.createSpan({ cls: "dbx-sync-explorer-progress-summary-icons" });
  switch (type) {
    case "upload":
      appendSummaryIcon(wrap, "arrow-up");
      break;
    case "download":
      appendSummaryIcon(wrap, "arrow-down");
      break;
    case "conflict":
      // Circle-slash ≈ Ghostbusters stop; inherits white from CSS.
      appendSummaryIcon(wrap, "ban");
      break;
    case "deleteLocal":
      appendSummaryIcon(wrap, "arrow-down");
      appendSummaryIcon(wrap, "trash-2");
      break;
    case "deleteRemote":
      appendSummaryIcon(wrap, "arrow-up");
      appendSummaryIcon(wrap, "trash-2");
      break;
  }
}

function appendSummaryIcon(parent: HTMLElement, iconId: string): void {
  const iconEl = parent.createSpan({ cls: "dbx-sync-explorer-progress-summary-icon" });
  setIcon(iconEl, iconId);
}

/** Indeterminate active fill — small stub so the bar does not jump from full→1% later. */
const INDETERMINATE_FILL_PERCENT = 5;

/**
 * Width % for the segment fill.
 * Scan / figuring-out stays at a 5% stub so the bar does not fill fully before execute.
 * Sync with unknown total also uses the stub; once execute has a total, normal %.
 */
function fillPercent(seg: SectionProgressSegment): number {
  if (seg.state === "pending") return 0;
  // Finished with no execute totals (e.g. empty plan) still show a complete bar.
  if (seg.state !== "active" && seg.total <= 0) return 100;
  // Scanning / discovering file count — hold at 5% even while onScanProgress ticks.
  if (seg.state === "active" && seg.phase === "scan") return INDETERMINATE_FILL_PERCENT;
  // Indeterminate sync (before first onProgress).
  if (seg.total <= 0) return INDETERMINATE_FILL_PERCENT;
  return Math.min(100, Math.round((seg.completed / seg.total) * 100));
}

/** How many recent activity paths the count-link peek keeps (newest first in storage). */
const RECENT_PATH_LIMIT = 3;

/** Split `folder/note.md` so the panel can truncate the folder and keep the name. */
function splitVaultPath(path: string): { dirPrefix: string; fileName: string } {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  if (slash < 0) return { dirPrefix: "", fileName: normalized };
  return {
    dirPrefix: normalized.slice(0, slash + 1),
    fileName: normalized.slice(slash + 1) || normalized,
  };
}

/**
 * Render path as one continuous run (faint dir + bright name) for the recent-path peek.
 * CSS on the row uses rtl truncation so overflow ellipsis clips the start of the path
 * and short lines sit flush right with no gap between dir and name.
 */
function appendSplitPath(parent: HTMLElement, path: string): void {
  const { dirPrefix, fileName } = splitVaultPath(path);
  // Inner LTR wrapper: row is rtl for leading-ellipsis; this keeps path characters LTR.
  const inner = parent.createSpan({ cls: "dbx-sync-explorer-progress-path-inner" });
  if (dirPrefix) {
    inner.createSpan({
      text: dirPrefix,
      cls: "dbx-sync-explorer-progress-path-dir",
    });
  }
  inner.createSpan({
    text: fileName,
    cls: "dbx-sync-explorer-progress-path-name",
  });
}

/**
 * Opacity for a recent-path row in display order (oldest at top → newest at bottom).
 * Newest (last) is full opacity; the older rows above are much more faded.
 */
function recentPathOpacity(displayIndex: number, count: number): number {
  if (count <= 1 || displayIndex === count - 1) return 1;
  // Oldest of three: most faded; middle still clearly dimmer than the current file.
  if (displayIndex === 0 && count >= 3) return 0.22;
  return 0.38;
}

function shortLabel(section: ProgressSegmentId): string {
  switch (section) {
    case "notes":
      // Ticket: segment label is "Files" (vault notes + other in-scope files), not "Notes".
      return "Files";
    case "settings":
      return "Settings";
    case "plugins":
      return "Plugins";
    case "workspaces":
      return "Workspaces";
    case "deletions":
      return "Deletions";
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
