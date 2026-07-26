import { Notice, setIcon, type App, type WorkspaceLeaf } from "obsidian";
import {
  ACTION_SUMMARY_SEPARATOR,
  actionSummaryModalTitle,
  formatActionProgressValue,
  formatActionSummaryPart,
  formatActionSummaryValue,
  isLiveProgressActionType,
  LIVE_PROGRESS_ACTION_TYPES,
  type ActionSummaryPart,
  type ActionSummaryPaths,
  type ActionSummaryType,
} from "../sync/sync-reporter";
import type { VaultSection } from "../sync/sync-scope";
import {
  ActionPathsModal,
  type ChipLogLine,
} from "./action-paths-modal";
import { SyncCancelConfirmModal } from "./sync-cancel-confirm-modal";

export type { ChipLogLine };

export type SectionProgressState = "pending" | "active" | "success" | "partial" | "failed";

export type SectionProgressPhase = "idle" | "scan" | "sync";

/** Vault section bars plus the trailing deferred-deletes segment. */
export type ProgressSegmentId = VaultSection | "deletions";

/** Planned totals per action type for live upload/download chips during execute. */
export type ActionSummaryTotals = Partial<Record<ActionSummaryType, number>>;

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
   * Populated from scan activity so the scan count link can peek at recent work.
   */
  recentPaths: string[];
  /** Succeeded conflict paths — retained for callers; chips use summaryPaths. */
  conflictPaths: string[];
  /** Structured action counts for themed icons + accent/error values in the panel. */
  summaryParts: ActionSummaryPart[];
  /** Succeeded paths per action type — opened by summary chips. */
  summaryPaths: ActionSummaryPaths;
  /**
   * Planned upload/download totals while execute is active.
   * Cleared on markResult so finished chips show count-only values.
   */
  summaryTotals: ActionSummaryTotals;
  /**
   * Live attempt/retry/fail/success log per chip while execute runs.
   * Cleared on markResult; finished chips use summaryPaths only.
   */
  liveChipLogs: Partial<Record<ActionSummaryType, ChipLogLine[]>>;
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
 * Expanded detail uses short labels (Files/Settings/Plugins). Scan phase keeps an
 * accent count link that toggles a recent-path peek (up to 3). Execute phase with
 * uploads/downloads shows the same accent chips as finished summaries, with live
 * "completed / total" values (accent completed, theme-normal slash+total) that
 * settle into final counts on markResult. Finished sections with errors show a
 * failed chip plus upload/download/etc. for successes (not prose like
 * "8 failed, 406 ok"). Cancel mid-execute keeps earned chips and appends
 * Cancelled. Chip click opens a path/log modal (attempts + retries while live,
 * settled path lists when finished). Fallback aggregate count link is used only
 * when the plan has no upload/download work.
 * The Deletions detail text line is omitted when not actively deleting (counts already
 * appear as trash chips on vault-section lines).
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
  /** Live scan `completed/total` text nodes — updated in place so the count link stays clickable. */
  private countTextEls = new Map<ProgressSegmentId, HTMLElement>();
  /**
   * Live chip value nodes keyed by section+actionType so execute ticks rewrite text
   * without rebuilding the chip row (keeps the hit target stable).
   */
  private chipValueEls = new Map<string, HTMLElement>();
  private layoutHandler: (() => void) | null = null;
  /**
   * When true for this run, emit Notices for segment start/end because the explorer
   * was closed at show() (or later checks find it closed).
   */
  private segmentNoticesEnabled = false;
  /** Pending end message to combine with the next segment start into one Notice. */
  private pendingEndedNotice: string | null = null;
  /** Section whose recent-path peek is open under its scan-phase count link. */
  private recentPathsExpandedSection: ProgressSegmentId | null = null;
  /**
   * When the user opens the recent-path peek, keep showing it on later active segments
   * until they collapse it (or the run ends / is interrupted).
   */
  private recentPathsFollowActive = false;
  /**
   * Path modal opened from a summary chip — kept so live log lines can append while open.
   */
  private openPathModal: {
    section: ProgressSegmentId;
    actionType: ActionSummaryType;
    modal: ActionPathsModal;
  } | null = null;
  /**
   * Keys `${section}|${actionType}|${path}` already started this execute phase —
   * a second start becomes a "retrying" log line.
   */
  private liveChipStartedKeys = new Set<string>();

  /**
   * @param onCancel Confirmed cancel from the panel — typically aborts the in-flight sync.
   */
  constructor(
    private app: App,
    private onCancel: () => void,
  ) {}

  /** Show N segments for the selected sections (files → settings → plugins → workspaces order). */
  show(sections: VaultSection[]): void {
    this.closeOpenPathModal();
    this.liveChipStartedKeys.clear();
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
      summaryTotals: {},
      liveChipLogs: {},
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
      summaryTotals: {},
      liveChipLogs: {},
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
    // Clear prior-run chip state until beginLiveActionProgress seeds plan totals.
    seg.summaryParts = [];
    seg.summaryPaths = {};
    seg.summaryTotals = {};
    seg.liveChipLogs = {};
    this.clearLiveChipStartedKeysForSection(section);
    // Scan peek does not apply during execute chips — drop it for this section.
    if (this.recentPathsExpandedSection === section) {
      this.recentPathsExpandedSection = null;
    }
    this.render();
  }

  /**
   * Seed upload/download chips from the plan before execute starts.
   * Shows 0/total chips immediately; live log lines append via recordLiveAction*.
   */
  beginLiveActionProgress(
    section: ProgressSegmentId,
    planItems: { action: { type: string } }[],
  ): void {
    const seg = this.segments.find((s) => s.section === section);
    if (!seg || seg.state !== "active") return;

    const totals: ActionSummaryTotals = {};
    for (const item of planItems) {
      if (!isLiveProgressActionType(item.action.type)) continue;
      totals[item.action.type] = (totals[item.action.type] ?? 0) + 1;
    }

    const parts: ActionSummaryPart[] = [];
    for (const type of LIVE_PROGRESS_ACTION_TYPES) {
      const total = totals[type];
      if (total && total > 0) {
        parts.push({ type, count: 0 });
      }
    }

    seg.summaryTotals = totals;
    seg.summaryParts = parts;
    seg.summaryPaths = {};
    seg.liveChipLogs = {};
    this.clearLiveChipStartedKeysForSection(section);
    // Chip row replaces the aggregate count link when any upload/download work exists.
    this.renderDetail();
  }

  /**
   * Executor item start — first start is "attempt", later starts for the same
   * path+action are "retrying" (new line each time).
   */
  recordLiveActionStart(
    section: ProgressSegmentId,
    actionType: string,
    path: string,
  ): void {
    if (!isLiveProgressActionType(actionType)) return;
    const trimmed = path.trim();
    if (!trimmed) return;
    const key = liveChipStartKey(section, actionType, trimmed);
    const kind: ChipLogLine["kind"] = this.liveChipStartedKeys.has(key)
      ? "retrying"
      : "attempt";
    this.liveChipStartedKeys.add(key);
    this.appendLiveChipLog(section, actionType, { kind, path: trimmed });
  }

  /**
   * Executor item failure during live execute — append a failed log line so the
   * chip modal shows activity even when nothing has succeeded yet.
   */
  recordLiveActionFailure(
    section: ProgressSegmentId,
    actionType: string,
    path: string,
    error?: string,
  ): void {
    if (!isLiveProgressActionType(actionType)) return;
    const trimmed = path.trim();
    if (!trimmed) return;
    const shortError = error?.trim() ? truncateChipError(error.trim()) : undefined;
    this.appendLiveChipLog(section, actionType, {
      kind: "failed",
      path: trimmed,
      text: shortError,
    });
  }

  /**
   * Record one successful upload/download during execute.
   * Bumps the live chip value in place and appends to an open path modal for that type.
   */
  recordLiveActionSuccess(
    section: ProgressSegmentId,
    actionType: string,
    path: string,
  ): void {
    if (!isLiveProgressActionType(actionType)) return;
    const seg = this.segments.find((s) => s.section === section);
    if (!seg || seg.state !== "active" || seg.phase !== "sync") return;
    const total = seg.summaryTotals[actionType];
    if (!total) return;

    const trimmed = path.trim();
    if (!trimmed) return;

    const paths = seg.summaryPaths[actionType] ?? [];
    paths.push(trimmed);
    seg.summaryPaths[actionType] = paths;

    const part = seg.summaryParts.find((p) => p.type === actionType);
    if (part) {
      part.count = paths.length;
    } else {
      seg.summaryParts.push({ type: actionType, count: paths.length });
    }

    const valueEl = this.chipValueEls.get(chipValueKey(section, actionType));
    if (valueEl) {
      // Tick only the completed span so slash/total keep theme-aware styling.
      setLiveProgressValue(valueEl, paths.length, total);
      const chip = valueEl.closest(".dbx-sync-explorer-progress-summary-chip");
      if (chip instanceof HTMLElement) {
        chip.setAttr(
          "aria-label",
          `${actionSummaryModalTitle(actionType)} (${formatActionProgressValue(paths.length, total)})`,
        );
      }
    } else {
      this.renderDetail();
    }

    // Success also goes into the live log (and open modal) as a success line.
    this.appendLiveChipLog(section, actionType, { kind: "success", path: trimmed });
  }

  /** Append one live chip log line and mirror into an open modal for that chip. */
  private appendLiveChipLog(
    section: ProgressSegmentId,
    actionType: ActionSummaryType,
    line: ChipLogLine,
  ): void {
    const seg = this.segments.find((s) => s.section === section);
    if (!seg || seg.state !== "active" || seg.phase !== "sync") return;
    const logs = seg.liveChipLogs[actionType] ?? [];
    logs.push(line);
    seg.liveChipLogs[actionType] = logs;

    if (
      this.openPathModal
      && this.openPathModal.section === section
      && this.openPathModal.actionType === actionType
    ) {
      this.openPathModal.modal.appendLine(line);
    }
  }

  private clearLiveChipStartedKeysForSection(section: ProgressSegmentId): void {
    const prefix = `${section}|`;
    for (const key of [...this.liveChipStartedKeys]) {
      if (key.startsWith(prefix)) this.liveChipStartedKeys.delete(key);
    }
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
    // Local hash progress is vault/config-wide (e.g. 96 indexed files, 110 after
    // .obsidian disk merge) — not the section's sync plan. Keep "Scanning…" until
    // execute seeds real upload/download totals.
    if (seg.phase === "scan") {
      seg.completed = 0;
      seg.total = 0;
      seg.description = "Scanning changes…";
      const fill = this.fillEls.get(section);
      if (fill) {
        fill.style.width = `${fillPercent(seg)}%`;
      }
      return;
    }

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

    // Keep live ↑/↓ chips in lockstep with the bar when the plan is a single
    // upload-or-download wave (common for first sync / plugin pulls). Per-item
    // recordLiveActionSuccess can miss DOM ticks under heavy concurrency; the
    // bar already has the authoritative completed/total from the executor.
    if (seg.phase === "sync") {
      this.syncSingleLiveActionChip(section, seg, completed);
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
   * When exactly one live action type (upload or download) has a plan total,
   * mirror executor completed into that chip. Mixed upload+download plans keep
   * per-success chip ticks from recordLiveActionSuccess instead.
   */
  private syncSingleLiveActionChip(
    section: ProgressSegmentId,
    seg: SectionProgressSegment,
    completed: number,
  ): void {
    const liveTypes = LIVE_PROGRESS_ACTION_TYPES.filter(
      (type) => (seg.summaryTotals[type] ?? 0) > 0,
    );
    if (liveTypes.length !== 1) return;
    const actionType = liveTypes[0];
    const actionTotal = seg.summaryTotals[actionType];
    if (!actionTotal) return;

    const nextCount = Math.min(Math.max(0, completed), actionTotal);
    const part = seg.summaryParts.find((p) => p.type === actionType);
    if (part) {
      // Never move the chip backwards if per-item success ticks got ahead.
      if (nextCount < part.count) return;
      part.count = nextCount;
    } else {
      seg.summaryParts.push({ type: actionType, count: nextCount });
    }

    const valueEl = this.chipValueEls.get(chipValueKey(section, actionType));
    if (valueEl) {
      setLiveProgressValue(valueEl, nextCount, actionTotal);
      if (nextCount > 0) {
        const chip = valueEl.closest(".dbx-sync-explorer-progress-summary-chip");
        if (chip instanceof HTMLElement) {
          chip.removeClass("dbx-sync-explorer-progress-summary-chip-disabled");
          chip.removeAttribute("aria-disabled");
          chip.setAttr(
            "aria-label",
            `${actionSummaryModalTitle(actionType)} (${formatActionProgressValue(nextCount, actionTotal)})`,
          );
        }
      }
    } else if (hasLiveActionChips(seg)) {
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
    // Drop live totals/logs so finished chips render count-only path lists.
    seg.summaryTotals = {};
    seg.liveChipLogs = {};
    this.clearLiveChipStartedKeysForSection(section);
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
    // Reconcile an open live modal with the final path list for this section/type.
    if (this.openPathModal?.section === section) {
      const finalPaths = seg.summaryPaths[this.openPathModal.actionType] ?? [];
      this.openPathModal.modal.setPaths(finalPaths);
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

  /**
   * Mark the active/pending segment as failed and leave later ones as skipped.
   * Preserves any live upload/download chips already earned, settles them to
   * count-only values, and appends the interrupt reason (e.g. Cancelled).
   */
  markInterrupted(section: ProgressSegmentId | null, description: string): void {
    let hit = section === null;
    for (const seg of this.segments) {
      if (section && seg.section === section) {
        hit = true;
        if (seg.state === "pending" || seg.state === "active") {
          this.applyInterruptToSegment(seg, description);
        }
        continue;
      }
      if (hit && (seg.state === "pending" || seg.state === "active")) {
        this.applyInterruptToSegment(seg, "Skipped");
      }
    }
    this.recentPathsExpandedSection = null;
    this.recentPathsFollowActive = false;
    this.render();
  }

  /**
   * Settle an in-progress segment for cancel/auth/error: keep completed chips,
   * drop zero-count planned chips, and put the reason after the chip summary.
   */
  private applyInterruptToSegment(
    seg: SectionProgressSegment,
    description: string,
  ): void {
    seg.state = "failed";
    // Finished chips are count-only — drop live completed/total denominators.
    seg.summaryTotals = {};
    // Drop 0/total placeholders that never got a success before the interrupt.
    seg.summaryParts = seg.summaryParts.filter((part) => part.count > 0);
    if (seg.summaryParts.length > 0) {
      const partsSummary = seg.summaryParts
        .map(formatActionSummaryPart)
        .join(ACTION_SUMMARY_SEPARATOR);
      // Trailing prose after chips (renderFinishedDescription keeps it).
      seg.description = `${partsSummary}${ACTION_SUMMARY_SEPARATOR}${description}`;
    } else {
      seg.description = description;
    }
    if (seg.total <= 0) {
      seg.total = 1;
      seg.completed = 1;
    } else {
      seg.completed = seg.total;
    }
  }

  /** Hide and detach (also used on plugin unload). */
  destroy(): void {
    this.closeOpenPathModal();
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
    this.chipValueEls.clear();
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

  /**
   * Open the path/log modal for a summary chip (live or finished).
   * Live: attempt/retry/fail log (may be empty → "Waiting for activity…").
   * Finished: settled success/fail path lists from summaryPaths.
   */
  private openSummaryChipModal(
    section: ProgressSegmentId,
    actionType: ActionSummaryType,
  ): void {
    const seg = this.segments.find((s) => s.section === section);
    if (!seg) return;

    const isLive =
      seg.state === "active"
      && seg.phase === "sync"
      && (seg.summaryTotals[actionType] ?? 0) > 0;
    const liveLogs = seg.liveChipLogs[actionType] ?? [];
    const paths = seg.summaryPaths[actionType] ?? [];

    // Finished chips still need at least one path; live chips open with totals alone.
    if (!isLive && paths.length === 0 && liveLogs.length === 0) {
      return;
    }


    // Reuse the already-open modal for the same chip instead of stacking duplicates.
    if (
      this.openPathModal
      && this.openPathModal.section === section
      && this.openPathModal.actionType === actionType
    ) {
      if (isLive) {
        this.openPathModal.modal.setLines([...liveLogs], { useEventCount: true });
      } else {
        this.openPathModal.modal.setPaths(paths);
      }
      return;
    }

    this.closeOpenPathModal();
    const modal = isLive
      ? new ActionPathsModal(
        this.app,
        actionSummaryModalTitle(actionType),
        [...liveLogs],
        { useEventCount: true },
      )
      : new ActionPathsModal(
        this.app,
        actionSummaryModalTitle(actionType),
        [...paths],
      );
    this.openPathModal = { section, actionType, modal };
    modal.setOnCloseCallback(() => {
      if (this.openPathModal?.modal === modal) {
        this.openPathModal = null;
      }
    });
    modal.open();
  }

  /** Close any tracked path modal without waiting for the user. */
  private closeOpenPathModal(): void {
    const open = this.openPathModal;
    if (!open) return;
    this.openPathModal = null;
    open.modal.setOnCloseCallback(null);
    open.modal.close();
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
      // Disabled only for finished chips with no paths — live planned chips stay clickable.
      if (summaryChip.hasClass("dbx-sync-explorer-progress-summary-chip-disabled")) return;
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
    this.chipValueEls.clear();
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

      if (seg.state === "pending") {
        line.createSpan({
          text: seg.description,
          cls: "dbx-sync-explorer-progress-queued",
        });
      } else if (seg.state === "active" && hasLiveActionChips(seg)) {
        // Execute with upload/download plan totals — same chips as finished, live done/total.
        this.renderSummaryChips(line, seg, true);
      } else if (seg.state === "active" && seg.phase === "scan") {
        // Never show vault-hash N/M during scan — only "Scanning…" until plan totals exist.
        line.createSpan({ text: "Scanning changes…" });
      } else if (seg.state === "active" && seg.total > 0) {
        // Sync without upload/download chips: accent count link toggles recent-path peek.
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
      } else if (seg.state === "active") {
        // Active but no totals yet (e.g. syncing before first onProgress / plan seed).
        line.createSpan({ text: seg.description });
      } else {
        this.renderFinishedDescription(line, seg);
      }

      // Peek only for scan-phase count links — chips open the path modal instead.
      if (
        this.recentPathsExpandedSection === seg.section
        && seg.state === "active"
        && !hasLiveActionChips(seg)
      ) {
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

    this.renderSummaryChips(line, seg, false);

    if (trailing) {
      line.createSpan({ text: trailing });
    }
  }

  /**
   * Shared chip row for live execute progress and finished summaries.
   * When live, values are completed / total (accent + theme-normal) and the
   * value host is cached so ticks rewrite only the completed span.
   */
  private renderSummaryChips(
    line: HTMLElement,
    seg: SectionProgressSegment,
    isLive: boolean,
  ): void {
    const chips = line.createDiv({ cls: "dbx-sync-explorer-progress-summary-chips" });
    for (const part of seg.summaryParts) {
      const paths = seg.summaryPaths[part.type] ?? [];
      const liveLogs = seg.liveChipLogs[part.type] ?? [];
      const total = seg.summaryTotals[part.type];
      const showLiveProgress = isLive && total !== undefined;
      const valueText = showLiveProgress
        ? formatActionProgressValue(part.count, total)
        : formatActionSummaryValue(part);
      const chip = chips.createEl("a", {
        cls:
          part.type === "failed"
            ? "dbx-sync-explorer-progress-summary-chip dbx-sync-explorer-progress-summary-chip-failed"
            : "dbx-sync-explorer-progress-summary-chip",
        href: "#",
        attr: {
          "data-section": seg.section,
          "data-action-type": part.type,
          role: "button",
          "aria-label": `${actionSummaryModalTitle(part.type)} (${valueText})`,
        },
      });
      // Live chips with a plan total are always clickable (log modal). Finished chips
      // need at least one path (or live log leftover) before they open.
      const canOpen = showLiveProgress || paths.length > 0 || liveLogs.length > 0;
      if (!canOpen) {
        chip.addClass("dbx-sync-explorer-progress-summary-chip-disabled");
        chip.setAttr("aria-disabled", "true");
      }
      appendSummaryIcons(chip, part.type);
      if (showLiveProgress) {
        const valueEl = appendLiveProgressValue(chip, part.count, total);
        this.chipValueEls.set(chipValueKey(seg.section, part.type), valueEl);
      } else {
        chip.createSpan({
          text: valueText,
          cls: "dbx-sync-explorer-progress-summary-value",
        });
      }
    }
  }
}

/**
 * Live chip value: accent completed count, then theme-normal " / total".
 * Host is cached so recordLiveActionSuccess can tick the done span in place.
 */
function appendLiveProgressValue(
  parent: HTMLElement,
  completed: number,
  total: number,
): HTMLElement {
  const valueEl = parent.createSpan({
    cls:
      "dbx-sync-explorer-progress-summary-value dbx-sync-explorer-progress-summary-value-live",
  });
  valueEl.createSpan({
    text: String(completed),
    cls: "dbx-sync-explorer-progress-summary-value-done",
  });
  // Spaces around the slash are intentional — matches "3 / 10" reading.
  valueEl.createSpan({
    text: " / ",
    cls: "dbx-sync-explorer-progress-summary-value-sep",
  });
  valueEl.createSpan({
    text: String(total),
    cls: "dbx-sync-explorer-progress-summary-value-total",
  });
  return valueEl;
}

/** Update a live chip's completed count without rebuilding slash/total nodes. */
function setLiveProgressValue(
  valueEl: HTMLElement,
  completed: number,
  total: number,
): void {
  const doneEl = valueEl.querySelector(
    ".dbx-sync-explorer-progress-summary-value-done",
  );
  if (doneEl instanceof HTMLElement) {
    doneEl.setText(String(completed));
    return;
  }
  // Host missing structured children (unexpected) — rebuild in place.
  valueEl.empty();
  valueEl.addClass("dbx-sync-explorer-progress-summary-value-live");
  valueEl.createSpan({
    text: String(completed),
    cls: "dbx-sync-explorer-progress-summary-value-done",
  });
  valueEl.createSpan({
    text: " / ",
    cls: "dbx-sync-explorer-progress-summary-value-sep",
  });
  valueEl.createSpan({
    text: String(total),
    cls: "dbx-sync-explorer-progress-summary-value-total",
  });
}

/** Shallow-clone path arrays so segment state is not shared with caller maps. */
function cloneSummaryPaths(paths: ActionSummaryPaths): ActionSummaryPaths {
  const cloned: ActionSummaryPaths = {};
  for (const [type, list] of Object.entries(paths) as [ActionSummaryType, string[] | undefined][]) {
    if (list && list.length > 0) cloned[type] = [...list];
  }
  return cloned;
}

/** Stable key for in-place chip value updates during execute. */
function chipValueKey(section: ProgressSegmentId, actionType: ActionSummaryType): string {
  return `${section}:${actionType}`;
}

/** Tracks first vs subsequent executor starts for retrying log lines. */
function liveChipStartKey(
  section: ProgressSegmentId,
  actionType: string,
  path: string,
): string {
  return `${section}|${actionType}|${path}`;
}

/** Keep failed-chip error snippets short enough for one modal row. */
function truncateChipError(message: string, maxLen = 80): string {
  if (message.length <= maxLen) return message;
  return `${message.slice(0, maxLen - 1)}…`;
}

/** True when the active segment should show live upload/download chips instead of N/M. */
function hasLiveActionChips(seg: SectionProgressSegment): boolean {
  if (seg.phase !== "sync") return false;
  return LIVE_PROGRESS_ACTION_TYPES.some((type) => (seg.summaryTotals[type] ?? 0) > 0);
}

/** Lucide icons for panel summary — CSS uses --text-normal (emoji cannot). */
function appendSummaryIcons(parent: HTMLElement, type: ActionSummaryType): void {
  const wrap = parent.createSpan({ cls: "dbx-sync-explorer-progress-summary-icons" });
  switch (type) {
    case "failed":
      // Circle-X reads as a failed item without colliding with conflict’s ban icon.
      appendSummaryIcon(wrap, "circle-x");
      break;
    case "upload":
      appendSummaryIcon(wrap, "arrow-up");
      break;
    case "download":
      appendSummaryIcon(wrap, "arrow-down");
      break;
    case "conflict":
      // Circle-slash ≈ Ghostbusters stop; colour comes from themed CSS.
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
