import type { FileSystem, RemoteStorage, SyncStateStore } from "../adapters/interfaces";
import type {
  PathGuardIssue,
  PathIssueResolution,
  RemoteEntry,
  SyncPlan,
  SyncPlanItem,
  SyncResult,
} from "../types";
import { emptySyncPlanStats } from "../types";
import { checkPathGuard } from "./path-guard";
import { createPlan } from "./planner";
import { enhanceSyncPlan } from "./plan-enhancements";
import type { ConflictStrategy, ConflictResolver, DeleteGuardResult } from "../types";
import { executePlan } from "./executor";
import { unionPathLowers } from "./delete-coalesce";
import { checkDeleteGuard, splitPlanDeletes } from "./guards";
import { DropboxAdapter, DropboxCursorResetError } from "../adapters/dropbox-adapter";
import { isExcluded } from "../exclude";
import { CycleContext } from "./cycle-context";
import type { SyncLiveReportSink } from "../ui/sync-live-report";
import { VaultAdapter, type LocalFileScanCallback } from "../adapters/vault-adapter";
import { isPathInScope, isPathInSections, type SyncScope, type VaultSection } from "./sync-scope";
import {
  countBasePlugins,
  countDeleteIntentSources,
  countLocalBySection,
  countRemotePlugins,
  emitDiagnosticsPhaseLines,
  countBaseNotes,
  shouldDeferInferredDeletes,
  summarizeDeletePlan,
  type DeleteIntentSource,
  type SyncCycleDiagnostics,
} from "./sync-diagnostics";
import {
  didScopeWiden,
  parseScopeFingerprint,
  serializeScopeFingerprint,
  type ScopeFingerprint,
} from "./scope-fingerprint";
import { applyResurrectionGuard, type ResurrectionResolver } from "./resurrection-guard";
import { classifyVaultPath } from "./sync-scope";
import {
  countByActionType,
  hasNestedOtherFilesPath,
  samplePaths,
  logRule,
  summarizeDeleteRemotePathShapes,
  SyncHypotheses,
  SyncRules,
  type SyncMonitorLog,
} from "../debug/sync-monitor";
import { isConflictFile } from "./conflict-handlers";
import { logTemp } from "../debug/temp-log";
import type { DeferralTracker } from "./deferral-tracker";
import {
  buildRetrySetAfterCycle,
  mergeRetryItemsIntoPlan,
  parseRetrySet,
  RETRY_SET_META_KEY,
  serializeRetrySet,
} from "./retry-set";
import {
  filterPermanentSkippedItems,
  mergePermanentSkipAfterCycle,
  parsePermanentSkipSet,
  PERMANENT_SKIP_META_KEY,
  serializePermanentSkipSet,
  type PermanentSkipEntry,
} from "./permanent-skip";

export { isConflictFile } from "./conflict-handlers";

export interface SyncEngineDeps {
  fs: FileSystem;
  remote: RemoteStorage;
  store: SyncStateStore;
}

export interface SyncEngineOptions {
  conflictStrategy?: ConflictStrategy;
  conflictResolver?: ConflictResolver;
  deleteProtection?: boolean;
  deleteThreshold?: number;
  /** 대량 삭제 시 사용자 확인 콜백. true면 삭제 실행, false면 스킵 */
  onDeleteGuardTriggered?: (guard: DeleteGuardResult) => Promise<boolean>;
  /**
   * Active file or dirty open tab — defer download/conflict/deleteLocal (G19/G10).
   * When omitted, isFileActive is used for backward compatibility.
   */
  shouldDeferApply?: (path: string) => boolean;
  /** @deprecated Prefer shouldDeferApply — still honoured when shouldDeferApply is absent. */
  isFileActive?: (path: string) => boolean;
  /** G21: deleteLocal while the file is open — true deletes here, false keeps editing. */
  confirmDeleteLocalWhileOpen?: (path: string) => Promise<boolean>;
  /** Reload an open markdown view after a bounded deferral apply (row 18). */
  reloadOpenFile?: (path: string) => Promise<void>;
  /** Shared per-sync deferral clock (G10). Plugin supplies one instance per syncNow. */
  deferralTracker?: DeferralTracker;
  /** G3: ask before uploading new_local when list_revisions finds no deletion evidence. */
  resurrectionResolver?: ResurrectionResolver;
  /** G28: background scope fingerprint — cursor reset when this widens. */
  persistentScopeFingerprint?: ScopeFingerprint;
  /** 파일 제외 패턴 */
  excludePatterns?: string[];
  /** 병렬 실행 동시성. 기본값 1 (순차) */
  concurrency?: number;
  /** 항목 실행 완료 시마다 호출. (완료 수, 전체 수, 실패 수) */
  onProgress?: (completed: number, total: number, failed: number) => void;
  /**
   * Local vault list/hash progress during the scan phase (before plan).
   * Drives explorer segment fill while the section is still "Scanning…".
   */
  onScanProgress?: (completed: number, total: number) => void;
  /**
   * Path currently being scanned or executed. Feeds the explorer progress
   * count-link peek (current + previous two files).
   */
  onActivityPath?: (path: string) => void;
  /**
   * Called after the plan is built (non-noop actions only) and before guards/execute.
   * Used to promote a large background sync to interactive progress UI.
   */
  onPlanReady?: (plan: SyncPlan) => void | Promise<void>;
  /** conflict 직렬 실행 전 호출. conflict 총 수 전달. */
  onConflictCount?: (count: number) => void;
  /** 사이클 리포트 활성화 */
  enableCycleReports?: boolean;
  /** 사이클 리포트 저장 콜백 */
  onCycleReport?: (report: string, cycleId: string) => Promise<void>;
  /** iOS/모바일에서 로컬 경로 규칙 적용 */
  strictLocalPaths?: boolean;
  /** 호환되지 않는 경로 감지 시 모달 등 처리 */
  onPathIssues?: (issues: PathGuardIssue[]) => Promise<PathIssueResolution>;
  /** G14: file-vs-folder collisions — notice/modal; items are skipped from execute. */
  onPathCollisions?: (items: SyncPlanItem[]) => void | Promise<void>;
  /** Adapter-scan vault root for hidden/dot paths (user setting). */
  includeHiddenFilesAndFolders?: boolean;
  /**
   * When true, skip Dropbox cursor write after a successful cycle.
   * Used for intermediate sections in sequential manual sync so later
   * sections still see the same delta set.
   */
  deferCursorUpdate?: boolean;
  /**
   * When true, strip all deleteLocal/deleteRemote from execute and return them
   * as pendingDeletes (no delete-protection modal). Manual multi-section sync
   * confirms and runs those deletes in a trailing Deletions progress segment.
   */
  deferDeletes?: boolean;
  /**
   * Structured sync monitor (vault file + Wi‑Fi ingest). Optional so unit tests
   * need not supply logging.
   */
  log?: SyncMonitorLog;
  /** deleteLocal 실행 직전 — vault delete 이벤트와 엔진 삭제를 구분 */
  onBeforeDeleteLocal?: (pathLower: string) => void;
  /**
   * Per-item execute lifecycle (background + manual).
   * Used for per-file status bar; explorer activity still uses onActivityPath.
   */
  onExecItem?: (
    localPath: string,
    actionType: string,
    event: "start" | "end",
    ok?: boolean,
    error?: string,
  ) => void;
  /** G13: explanatory Notice when resurrection / casing / duplicate paths sync. */
  onPathNotice?: (message: string) => void;
}

export interface CycleResult {
  plan: SyncPlan;
  result: SyncResult;
  /** 삭제 가드에 의해 스킵된 항목 수 */
  deletesSkipped?: number;
  /**
   * Deletes held back when deferDeletes is on (manual section loop).
   * Confirmed/executed later via executeDeletePlan.
   */
  pendingDeletes?: SyncPlanItem[];
  /** 활성 파일 보호로 건너뛴 항목 수 */
  deferredCount?: number;
  /** 경로 rename 적용됨 — 재동기화 필요 */
  pathRenamesApplied?: boolean;
  /** 경로 문제로 스킵한 항목 수 */
  pathsSkipped?: number;
  /** 사이클 리포트 (JSONL) */
  cycleReport?: string;
  /** Per-cycle diagnostics for sync-logs and debug log. */
  diagnostics?: SyncCycleDiagnostics;
  /** Whether finalizeState committed the Dropbox cursor this cycle (G30). */
  cursorUpdated?: boolean;
  /** Paths durably skipped after permanent failure classification (G17). */
  permanentSkips?: PermanentSkipEntry[];
}

/**
 * 동기화 엔진.
 * runCycle()로 한 번의 동기화 사이클을 실행한다.
 *
 * 1. 로컬 파일 수집 + hash 계산
 * 2. 원격 변경 수집 (cursor 기반 delta)
 * 3. 이전 상태(base) 로드
 * 4. base + delta 병합 → 전체 원격 상태 구성
 * 5. Planner로 동기화 계획 생성 (삭제 의도 전달)
 * 6. 삭제 가드 적용
 * 7. Executor로 계획 실행
 * 8. 모두 성공 시에만 cursor 갱신
 */
export class SyncEngine {
  private deletedPaths = new Set<string>();
  private deleteIntentSources = new Map<string, DeleteIntentSource>();
  private lastDiagnostics: SyncCycleDiagnostics | null = null;
  private liveReport: SyncLiveReportSink | null = null;
  private syncScope: SyncScope = "everything";
  private sectionFilter: VaultSection[] | null = null;
  private configDir = ".obsidian";
  /** Newest Dropbox cursor from the last cycle fetch — used after deferred deletes. */
  private lastFetchedCursor: string | null = null;
  /**
   * Union of non-deleted remote path_lowers across sections in this sync —
   * reused by executeDeletePlan so deferred Deletions can still coalesce.
   * Reset once per syncNow; each runCycle unions (never replaces with empty).
   */
  private lastExistingRemotePathLowers: string[] = [];
  /** Mirrors the last finalizeState cursor write for syncNow logging (G30). */
  private lastCursorUpdated = false;
  /** G17: paths durably skipped after permanent failure classification. */
  private lastPermanentSkips: PermanentSkipEntry[] = [];
  /** G22: false when VaultAdapter disk scan reported list errors this cycle. */
  private lastScanVouched = true;

  constructor(
    private deps: SyncEngineDeps,
    private options: SyncEngineOptions = {},
  ) {}

  /**
   * Clear the coalesce remote snapshot at the start of a sync so sections
   * cannot inherit a prior run's paths.
   */
  resetCoalesceRemoteSnapshot(): void {
    this.lastExistingRemotePathLowers = [];
  }

  /** Per-sync live markdown report (set before each runCycle). */
  setLiveReport(report: SyncLiveReportSink | null): void {
    this.liveReport = report;
  }

  /** 동기화 범위 — manual single scope (set before each runCycle). */
  setSyncScope(scope: SyncScope, configDir: string): void {
    this.syncScope = scope;
    this.sectionFilter = null;
    this.configDir = configDir;
  }

  /** Background sync — multiple vault sections (set before each runCycle). */
  setSyncSections(sections: VaultSection[], configDir: string): void {
    this.sectionFilter = sections;
    this.configDir = configDir;
  }

  /** Defer cursor persistence across multi-section manual runs (see SyncEngineOptions). */
  setDeferCursorUpdate(defer: boolean): void {
    this.options.deferCursorUpdate = defer;
  }

  /**
   * Hold deletes out of section execute for the manual Deletions progress segment.
   * Preserved across applyOptions like deferCursorUpdate.
   */
  setDeferDeletes(defer: boolean): void {
    this.options.deferDeletes = defer;
  }

  /**
   * Refresh options each sync cycle (callbacks + settings) without dropping
   * in-flight deferCursorUpdate / deferDeletes used by multi-section manual runs.
   */
  applyOptions(options: SyncEngineOptions): void {
    const deferCursorUpdate = this.options.deferCursorUpdate;
    const deferDeletes = this.options.deferDeletes;
    this.options = { ...options, deferCursorUpdate, deferDeletes };
  }

  private log(
    message: string,
    data?: Record<string, unknown>,
    meta?: { hypothesisId?: string; location?: string },
  ): void {
    this.options.log?.(message, data, meta);
  }

  private pathInScope(path: string): boolean {
    const patterns = this.options.excludePatterns ?? [];
    if (this.sectionFilter) {
      return isPathInSections(path, this.sectionFilter, this.configDir, patterns);
    }
    return isPathInScope(path, this.syncScope, this.configDir, patterns);
  }

  /** Whether the last cycle (or commitDeferredCursor) advanced the Dropbox cursor. */
  getLastCursorUpdated(): boolean {
    return this.lastCursorUpdated;
  }

  /** 로컬 삭제 이벤트 기록 — scoped like planning (G30); skips unchanged path_lower renames (C1). */
  trackDelete(pathLower: string, displayPath?: string): void {
    const vaultPath = displayPath ?? pathLower;
    if (!this.pathInScope(vaultPath)) {
      logTemp(this.options.log, "P4", "ignored out-of-scope delete intent", {
        path: vaultPath,
        pathLower,
      }, { location: "engine.trackDelete" });
      return;
    }
    this.deletedPaths.add(pathLower);
    this.deleteIntentSources.set(pathLower, "event");
    // #region agent log
    // If vault events emit nested Files/Other/Files paths, they are being created live.
    if (hasNestedOtherFilesPath(pathLower)) {
      this.log("trackDelete nested Files/Other/Files path", {
        path: pathLower,
        source: "event",
      }, { hypothesisId: SyncHypotheses.pathShape, location: "engine.trackDelete" });
    }
    // #endregion
  }

  /** 잘못 기록된 삭제 의도 제거 (경로 rename 등) */
  clearDeleteIntent(pathLower: string): void {
    this.deletedPaths.delete(pathLower);
    this.deleteIntentSources.delete(pathLower);
  }

  /** 저장된 삭제 로그에서 복원 */
  restoreDeleteLog(paths: string[]): void {
    let nestedOtherFiles = 0;
    for (const p of paths) {
      this.deletedPaths.add(p);
      if (!this.deleteIntentSources.has(p)) {
        this.deleteIntentSources.set(p, "persisted");
      }
      if (hasNestedOtherFilesPath(p)) nestedOtherFiles++;
    }
    // #region agent log
    if (nestedOtherFiles > 0) {
      this.log("restoreDeleteLog contains nested Files/Other/Files paths", {
        totalRestored: paths.length,
        nestedOtherFiles,
        sample: samplePaths(paths.filter((p) => hasNestedOtherFilesPath(p))),
      }, { hypothesisId: SyncHypotheses.pathShape, location: "engine.restoreDeleteLog" });
    }
    // #endregion
  }

  /** Drop all delete intents (settings “Clear sync history”). */
  clearDeleteLog(): void {
    this.deletedPaths.clear();
    this.deleteIntentSources.clear();
  }

  /** 현재 삭제 로그 반환 (영속화용) */
  getDeleteLog(): string[] {
    return [...this.deletedPaths];
  }

  /** 미소비 삭제 항목 존재 여부 (in-scope only — G30). */
  hasPendingDeletes(): boolean {
    return this.countInScopePendingDeletes() > 0;
  }

  /** In-scope delete intents that can block cursor finalize. */
  countInScopePendingDeletes(): number {
    let count = 0;
    for (const pathLower of this.deletedPaths) {
      if (this.deleteIntentPathInScope(pathLower)) count++;
    }
    return count;
  }

  private deleteIntentPathInScope(pathLower: string): boolean {
    // path_lower keys are vault-relative; scope checks accept either casing.
    return this.pathInScope(pathLower);
  }

  /** Drop delete intents outside enabled sections so they never block the cursor (G30). */
  clearOutOfScopeDeleteIntents(): number {
    let cleared = 0;
    for (const pathLower of [...this.deletedPaths]) {
      if (!this.deleteIntentPathInScope(pathLower)) {
        this.clearDeleteIntent(pathLower);
        cleared++;
      }
    }
    if (cleared > 0) {
      logTemp(this.options.log, "P4", "cleared out-of-scope delete intents", {
        cleared,
      }, { location: "engine.clearOutOfScopeDeleteIntents" });
    }
    return cleared;
  }

  /**
   * Clear delete intents the plan proved moot — file still present at same path_lower (C10/C1).
   */
  clearMootDeleteIntents(localFiles: import("../types").FileInfo[]): number {
    const localPathSet = new Set(localFiles.map((f) => f.pathLower));
    let cleared = 0;
    for (const pathLower of [...this.deletedPaths]) {
      if (localPathSet.has(pathLower)) {
        this.clearDeleteIntent(pathLower);
        cleared++;
        logTemp(this.options.log, "P4", "cleared moot delete intent — file still present", {
          pathLower,
        }, { location: "engine.clearMootDeleteIntents" });
      }
    }
    return cleared;
  }

  async runCycle(signal?: AbortSignal): Promise<CycleResult> {
    const { fs, remote, store } = this.deps;
    this.attachAbortSignal(signal);
    try {
      return await this.runCycleInner(signal);
    } finally {
      this.attachAbortSignal(undefined);
    }
  }

  private attachAbortSignal(signal?: AbortSignal): void {
    if (this.deps.fs instanceof VaultAdapter) {
      this.deps.fs.setAbortSignal(signal ?? null);
    }
    if (this.deps.remote instanceof DropboxAdapter) {
      this.deps.remote.setAbortSignal(signal);
    }
  }

  private async runCycleInner(signal?: AbortSignal): Promise<CycleResult> {
    const { fs, remote, store } = this.deps;
    const ctx = this.options.enableCycleReports ? new CycleContext() : undefined;
    const cycleStartedAt = Date.now();

    // 0. 사이클 시작 이벤트
    const cursorAtStart = await store.getMeta("cursor");
    if (ctx) {
      ctx.emit({ type: "cycle_start", ts: ctx.startTime, cursor: cursorAtStart ?? null });
    }
    this.log("cycle start", {
      cursorPresent: !!cursorAtStart,
      cursorPrefix: cursorAtStart ? cursorAtStart.slice(0, 12) : null,
      deleteLogSize: this.deletedPaths.size,
      inScopeDeleteLog: this.countInScopePendingDeletes(),
      sections: this.sectionFilter,
      syncScope: this.syncScope,
      deferCursorUpdate: !!this.options.deferCursorUpdate,
      deleteProtection: !!this.options.deleteProtection,
      deleteThreshold: this.options.deleteThreshold ?? 5,
    }, { hypothesisId: SyncHypotheses.sync, location: "engine.runCycle" });

    this.clearOutOfScopeDeleteIntents();

    // 1. 로컬 파일 수집
    signal?.throwIfAborted();
    const localScanStart = Date.now();
    await this.liveReport?.phaseStart(1);
    const localScanCb: LocalFileScanCallback = (path, detail) => {
      this.liveReport?.line(`\`${path}\` (${detail})`);
      // Drive the explorer recent-path peek during local list/hash.
      this.options.onActivityPath?.(path);
    };
    this.attachLocalScanCallback(localScanCb);
    // Drive explorer scan fill from VaultAdapter hashing (indexed + disk merges).
    this.attachLocalScanProgress((completed, total) => {
      this.options.onScanProgress?.(completed, total);
    });
    let localFiles: import("../types").FileInfo[];
    let localFolders: import("../types").FolderInfo[] = [];
    let allLocalFiles: import("../types").FileInfo[] = [];
    const configDiskScan = this.sectionFilter?.some((s) => s !== "notes") ?? false;
    const listOpts = {
      configDir: this.configDir,
      configDiskScan,
      includeHiddenFilesAndFolders: this.options.includeHiddenFilesAndFolders ?? false,
    };
    try {
      allLocalFiles = this.collectLocalFiles(await fs.list(listOpts));
      localFiles = allLocalFiles.filter((f) => this.pathInScope(f.path));
      localFolders = (await fs.listFolders(listOpts)).filter((f) => this.pathInScope(f.path));
    } finally {
      this.attachLocalScanCallback(null);
      this.attachLocalScanProgress(null);
    }
    const listStats =
      fs instanceof VaultAdapter
        ? fs.lastListStats
        : {
            vaultIndexed: allLocalFiles.length,
            configDiskAdded: 0,
            hiddenDiskAdded: 0,
            mergedBeforeExclude: allLocalFiles.length,
            mergedAfterExclude: allLocalFiles.length,
          };
    this.lastScanVouched = fs instanceof VaultAdapter
      ? fs.lastScanCompleteness.vouched
      : true;
    if (!this.lastScanVouched && fs instanceof VaultAdapter) {
      logTemp(this.options.log, "P3", "local scan not vouched — deferring inferred deletes", {
        listErrors: fs.lastScanCompleteness.listErrors.slice(0, 8),
      }, { location: "engine.localScan" });
    }
    const inScopeBySection = countLocalBySection(localFiles, this.configDir);
    this.lastDiagnostics = {
      local: {
        vaultIndexed: listStats.vaultIndexed,
        configDiskAdded: listStats.configDiskAdded,
        hiddenDiskAdded: listStats.hiddenDiskAdded,
        mergedAfterExclude: listStats.mergedAfterExclude,
        inScope: localFiles.length,
        outOfScope: listStats.mergedAfterExclude - localFiles.length,
        bySection: inScopeBySection,
      },
      syncState: {
        baseInScope: 0,
        remoteInScope: 0,
        basePlugins: 0,
        remotePlugins: 0,
        localPlugins: inScopeBySection.plugins,
      },
      deleteIntent: {
        totalInLog: this.deletedPaths.size,
        fromVaultEvents: 0,
        fromPersistedLog: 0,
        inferredThisCycle: 0,
        inferredSample: [],
        inferredSkippedPlugin: 0,
        inferredSkippedNotes: 0,
      },
      deletePlan: {
        deleteRemote: 0,
        deleteLocal: 0,
        deleteRemoteBySource: {},
        deleteRemoteSample: [],
      },
    };
    emitDiagnosticsPhaseLines(this.liveReport, "scan", this.lastDiagnostics);
    await this.liveReport?.phaseEnd(`${localFiles.length} file(s) scanned`);
    ctx?.emit({ type: "local_scan", ts: Date.now(), fileCount: localFiles.length, duration: Date.now() - localScanStart });
    this.log("phase local scan done", {
      durationMs: Date.now() - localScanStart,
      inScope: localFiles.length,
      vaultIndexed: listStats.vaultIndexed,
      configDiskAdded: listStats.configDiskAdded,
      hiddenDiskAdded: listStats.hiddenDiskAdded,
      mergedAfterExclude: listStats.mergedAfterExclude,
      bySection: inScopeBySection,
    }, { hypothesisId: SyncHypotheses.sync, location: "engine.localScan" });

    // 2. 원격 변경 수집 (delta)
    await this.liveReport?.phaseStart(2);
    const remoteFetchStart = Date.now();
    const { deltaEntries, latestCursor, inScopeDeltaCount, usedFullListing } = await this.fetchRemoteDeltas(
      store,
      remote,
      signal,
      ctx,
    );
    // Keep for executeDeletePlan after a deferred-deletes manual run.
    this.lastFetchedCursor = latestCursor;
    await this.liveReport?.phaseEnd(
      `${inScopeDeltaCount} in-scope remote entry/entries (${deltaEntries.length} delta total)`,
    );
    this.log("phase remote delta done", {
      durationMs: Date.now() - remoteFetchStart,
      deltaTotal: deltaEntries.length,
      inScopeDeltaCount,
      deletedInDelta: deltaEntries.filter((e) => e.deleted).length,
      usedFullListing,
      latestCursorPrefix: latestCursor.slice(0, 12),
    }, { hypothesisId: SyncHypotheses.sync, location: "engine.remoteDelta" });

    // 3. 이전 상태 로드
    signal?.throwIfAborted();
    const baseEntries = (await store.getAllEntries()).filter((e) =>
      this.pathInScope(e.localPath),
    );

    // 4. base + delta 병합 → 전체 원격 상태
    const fullRemoteMap = this.buildFullRemoteState(baseEntries, deltaEntries, usedFullListing);
    this.filterRemoteMapByScope(fullRemoteMap);
    // Union into the sync-wide coalesce snapshot (never replace with an empty section).
    this.lastExistingRemotePathLowers = unionPathLowers(
      this.lastExistingRemotePathLowers,
      [...fullRemoteMap.entries()]
        .filter(([, entry]) => !entry.deleted)
        .map(([pathLower]) => pathLower),
    );

    if (this.lastDiagnostics) {
      this.lastDiagnostics.syncState.baseInScope = baseEntries.length;
      this.lastDiagnostics.syncState.remoteInScope = fullRemoteMap.size;
      this.lastDiagnostics.syncState.basePlugins = countBasePlugins(baseEntries, this.configDir);
      this.lastDiagnostics.syncState.remotePlugins = countRemotePlugins(fullRemoteMap, this.configDir);
    }

    // 5. catch-up: vault 이벤트 누락 보완
    const inferred = this.inferMissingDeletes(localFiles, fullRemoteMap, baseEntries);
    if (this.lastDiagnostics) {
      const intentSources = countDeleteIntentSources(
        this.deletedPaths,
        this.deleteIntentSources,
      );
      this.lastDiagnostics.deleteIntent = {
        totalInLog: this.deletedPaths.size,
        fromVaultEvents: intentSources.event,
        fromPersistedLog: intentSources.persisted,
        inferredThisCycle: inferred.count,
        inferredSample: inferred.sample,
        inferredSkippedPlugin: inferred.skippedPluginInfer,
        inferredSkippedNotes: inferred.skippedNotesInfer,
      };
      emitDiagnosticsPhaseLines(this.liveReport, "intent", this.lastDiagnostics);
      // #region agent log
      this.log("delete intent after infer", {
        totalInLog: this.deletedPaths.size,
        fromVaultEvents: intentSources.event,
        fromPersistedLog: intentSources.persisted,
        inferredThisCycle: inferred.count,
        inferredSkippedPlugin: inferred.skippedPluginInfer,
        inferredSkippedNotes: inferred.skippedNotesInfer,
        inferredSample: inferred.sample,
        localInScope: localFiles.length,
        baseInScope: baseEntries.length,
        remoteInScope: fullRemoteMap.size,
      }, { hypothesisId: SyncHypotheses.reInferDeletes, location: "engine.inferMissingDeletes" });
      // #endregion
    }

    // 6. 동기화 계획 생성
    signal?.throwIfAborted();
    const fullRemoteEntries = Array.from(fullRemoteMap.values());
    await this.liveReport?.phaseStart(3);
    const planStart = Date.now();
    let planItemsLogged = 0;
    const plan = enhanceSyncPlan(
      createPlan(localFiles, fullRemoteEntries, baseEntries, {
        localDeletedPaths: this.deletedPaths,
        ctx,
        log: this.options.log,
        onPlanItem: (pathLower, localPath, actionType, reason) => {
          if (planItemsLogged < 15) {
            this.liveReport?.line(`\`${localPath}\` → **${actionType}** (${reason})`);
            planItemsLogged++;
          }
        },
      }),
      {
        localFiles,
        localFolders,
        remoteEntries: fullRemoteEntries,
        baseEntries,
        localDeletedPaths: this.deletedPaths,
        log: this.options.log,
      },
    );
    this.clearMootDeleteIntents(localFiles);

    const collisionItems = plan.items.filter((i) => i.action.type === "pathCollision");
    if (collisionItems.length > 0) {
      logTemp(this.options.log, "P5", "path collisions detected — skipping destructive actions", {
        count: collisionItems.length,
        paths: collisionItems.map((i) => i.localPath).slice(0, 8),
      }, { location: "engine.runCycle" });
      await this.options.onPathCollisions?.(collisionItems);
    }

    const retryEntries = parseRetrySet(await store.getMeta(RETRY_SET_META_KEY));
    const permanentSkips = parsePermanentSkipSet(await store.getMeta(PERMANENT_SKIP_META_KEY));
    const mergedPlanItems = mergeRetryItemsIntoPlan(plan.items, retryEntries);
    const mergedWithoutPermanent = filterPermanentSkippedItems(mergedPlanItems, permanentSkips);
    if (mergedWithoutPermanent.length !== mergedPlanItems.length) {
      logTemp(this.options.log, "P6", "filtered permanent-skip paths from plan", {
        skipped: mergedPlanItems.length - mergedWithoutPermanent.length,
        permanentSkipSize: permanentSkips.length,
      }, { location: "engine.runCycle" });
    }
    if (mergedPlanItems.length !== plan.items.length) {
      logTemp(this.options.log, "P4", "merged retry-set items into plan", {
        added: mergedPlanItems.length - plan.items.length,
        retrySetSize: retryEntries.length,
      }, { location: "engine.runCycle" });
    }
    const planWithRetry: SyncPlan = {
      ...plan,
      items: mergedWithoutPermanent,
    };

    const resurrectionPlan = await applyResurrectionGuard(planWithRetry, remote, {
      resolver: this.options.resurrectionResolver,
      log: this.options.log,
    });

    if (resurrectionPlan.items.length !== planWithRetry.items.length
      || resurrectionPlan.stats.preserveAsConflictCopy > 0) {
      logTemp(this.options.log, "P3", "resurrection guard adjusted plan", {
        before: planWithRetry.items.length,
        after: resurrectionPlan.items.length,
        preserveAsConflictCopy: resurrectionPlan.stats.preserveAsConflictCopy,
      }, { location: "engine.runCycle" });
    }

    const planForExecute = stripNonExecutablePlanItems(resurrectionPlan);
    if (plan.items.length > planItemsLogged) {
      this.liveReport?.line(`… and ${plan.items.length - planItemsLogged} more planned`);
    }
    if (this.lastDiagnostics) {
      this.lastDiagnostics.deletePlan = summarizeDeletePlan(plan, this.deleteIntentSources);
      emitDiagnosticsPhaseLines(this.liveReport, "plan", this.lastDiagnostics);
    }
    await this.liveReport?.phaseEnd(`${plan.items.length} action(s), ${plan.stats.noop} noop(s)`);
    const planActions = countByActionType(plan.items);
    this.log("phase plan done", {
      durationMs: Date.now() - planStart,
      actionCount: plan.items.length,
      noop: plan.stats.noop,
      actions: planActions,
      deleteRemoteSample: samplePaths(
        plan.items.filter((i) => i.action.type === "deleteRemote").map((i) => i.localPath),
      ),
      deleteLocalSample: samplePaths(
        plan.items.filter((i) => i.action.type === "deleteLocal").map((i) => i.localPath),
      ),
    }, { hypothesisId: SyncHypotheses.sync, location: "engine.plan" });

    // #region agent log
    // H-path: confirm Files/Other vs Files/Other/Files dual paths are stale history
    // (persisted/inferred intents for missing remotes) vs newly invented this cycle.
    {
      const localPathLowers = new Set(localFiles.map((f) => f.path.toLowerCase()));
      const remotePathLowers = new Set(fullRemoteMap.keys());
      const shapeSummary = summarizeDeleteRemotePathShapes({
        deleteRemotePaths: plan.items
          .filter((i) => i.action.type === "deleteRemote")
          .map((i) => i.localPath),
        deleteLogPaths: this.deletedPaths,
        intentSource: (pathLower) => this.deleteIntentSources.get(pathLower),
        remotePathLowers,
        localPathLowers,
      });
      if (
        shapeSummary.nestedOtherFilesCount > 0
        || shapeSummary.pairCount > 0
        || shapeSummary.sample.length > 0
      ) {
        this.log("deleteRemote path-shape analysis", shapeSummary, {
          hypothesisId: SyncHypotheses.pathShape,
          location: "engine.plan.pathShape",
        });
      }
    }
    // #endregion

    // Host may promote large background syncs to interactive UI before execute.
    await this.options.onPlanReady?.(planForExecute);

    // 7. Delete handling: either defer all deletes (manual section loop) or apply
    // the immediate delete-protection guard (background / single-cycle).
    let planToExecute = planForExecute;
    let deletesSkipped = 0;
    let pendingDeletes: SyncPlanItem[] | undefined;
    if (this.options.deferDeletes) {
      const split = splitPlanDeletes(planForExecute);
      planToExecute = split.nonDeletePlan;
      pendingDeletes = split.deleteItems.length > 0 ? split.deleteItems : undefined;
      if (pendingDeletes) {
        this.log("deferDeletes: holding deletes for trailing Deletions segment", {
          deleteCount: pendingDeletes.length,
          deleteRemote: pendingDeletes.filter((i) => i.action.type === "deleteRemote").length,
          deleteLocal: pendingDeletes.filter((i) => i.action.type === "deleteLocal").length,
          sample: samplePaths(pendingDeletes.map((i) => `${i.action.type}:${i.localPath}`)),
        }, { hypothesisId: SyncHypotheses.guardSkip, location: "engine.deferDeletes" });
      }
    } else {
      const guardResult = await this.applyDeleteGuard(planForExecute, ctx);
      planToExecute = guardResult.planToExecute;
      deletesSkipped = guardResult.deletesSkipped;
      if (this.lastDiagnostics?.deleteGuard?.triggered) {
        emitDiagnosticsPhaseLines(this.liveReport, "guard", this.lastDiagnostics);
      }
    }

    // 7b. 경로 호환성 가드
    let planToRun = planToExecute;
    let pathsSkipped = 0;
    await this.liveReport?.phaseStart(4);
    const pathGuard = checkPathGuard(planToRun, this.options.strictLocalPaths ?? false);
    if (!pathGuard.passed) {
      for (const issue of pathGuard.issues) {
        const types = issue.issues.map((i) => i.message).join("; ");
        this.liveReport?.line(
          `blocked \`${issue.item.localPath}\` (${issue.item.action.type}): ${types}`,
        );
      }
      if (this.options.onPathIssues) {
        const resolution = await this.options.onPathIssues(pathGuard.issues);
        if (resolution.action === "renamed") {
          const pairs = resolution.renames.map((r) => `\`${r.from}\` → \`${r.to}\``).join(", ");
          this.liveReport?.line(`resolution: **renamed** (${pairs})`);
          await this.liveReport?.phaseEnd("renames applied — execution deferred to next sync");
          return {
            plan,
            result: { succeeded: [], failed: [], deferred: [] },
            deletesSkipped,
            pathRenamesApplied: true,
            diagnostics: this.lastDiagnostics ?? undefined,
          };
        }
        if (resolution.action === "skip") {
          this.liveReport?.line("resolution: **skip** incompatible paths");
        }
        planToRun = pathGuard.filteredPlan;
        pathsSkipped = pathGuard.issues.length;
      } else {
        planToRun = pathGuard.filteredPlan;
        pathsSkipped = pathGuard.issues.length;
      }
    }
    await this.liveReport?.phaseEnd(
      pathGuard.passed
        ? "all paths compatible"
        : `${pathsSkipped} blocked, ${planToRun.items.length} remaining in plan`,
    );

    // 8. 계획 실행
    signal?.throwIfAborted();
    await this.liveReport?.phaseStart(5);
    let execFailed = 0;
    const execStart = Date.now();
    this.log("phase execute start", {
      planToRun: planToRun.items.length,
      actions: countByActionType(planToRun.items),
      deletesSkipped,
      pathsSkipped,
      concurrency: this.options.concurrency ?? 1,
    }, { hypothesisId: SyncHypotheses.sync, location: "engine.execute" });
    const result = await executePlan(planToRun, { fs, remote, store }, {
      conflictStrategy: this.options.conflictStrategy,
      conflictResolver: this.options.conflictResolver,
      shouldDeferApply: this.options.shouldDeferApply,
      isFileActive: this.options.isFileActive,
      confirmDeleteLocalWhileOpen: this.options.confirmDeleteLocalWhileOpen,
      reloadOpenFile: this.options.reloadOpenFile,
      deferralTracker: this.options.deferralTracker,
      signal,
      concurrency: this.options.concurrency,
      log: this.options.log,
      existingRemotePathLowers: this.lastExistingRemotePathLowers,
      onProgress: (completed, total) => {
        if (completed % 10 === 0 || completed === total) {
          this.liveReport?.progressLine(
            `${completed} / ${total} (${execFailed} failed)`,
          );
        }
        this.options.onProgress?.(completed, total, execFailed);
      },
      onConflictCount: this.options.onConflictCount,
      onBeforeDeleteLocal: this.options.onBeforeDeleteLocal,
      strictLocalPaths: this.options.strictLocalPaths,
      ctx,
      onExecItem: (localPath, actionType, event, ok, error) => {
        if (event === "start") {
          // Newest path when an item begins (concurrency may interleave starts).
          this.options.onActivityPath?.(localPath);
        }
        if (event === "end" && !ok) {
          execFailed++;
          this.liveReport?.line(`\`${localPath}\` — ${actionType} ✗ ${error ?? ""}`);
        }
        // Forward for per-file status (must run for background cycles too).
        this.options.onExecItem?.(localPath, actionType, event, ok, error);
      },
      onPathNotice: this.options.onPathNotice,
    });
    await this.liveReport?.phaseEnd(
      `${result.succeeded.length} ok, ${result.failed.length} failed, ${result.deferred.length} deferred`,
    );
    const deleteSucceeded = result.succeeded.filter(
      (i) => i.action.type === "deleteRemote" || i.action.type === "deleteLocal",
    );
    const deleteFailed = result.failed.filter(
      (f) => f.item.action.type === "deleteRemote" || f.item.action.type === "deleteLocal",
    );
    // #region agent log
    this.log("phase execute done", {
      durationMs: Date.now() - execStart,
      succeeded: result.succeeded.length,
      failed: result.failed.length,
      deferred: result.deferred.length,
      succeededByAction: countByActionType(result.succeeded),
      failedByAction: countByActionType(result.failed.map((f) => f.item)),
      deleteSucceeded: deleteSucceeded.length,
      deleteFailed: deleteFailed.length,
      deleteSucceededSample: samplePaths(deleteSucceeded.map((i) => `${i.action.type}:${i.localPath}`)),
      deleteFailedSample: samplePaths(
        deleteFailed.map((f) => `${f.item.action.type}:${f.item.localPath}:${f.error.message}`),
      ),
      timeoutFailures: result.failed.filter((f) => f.error.name === "ItemTimeoutError").length,
    }, {
      hypothesisId: deleteFailed.length > 0 || (deletesSkipped === 0 && deleteSucceeded.length === 0 && (planActions.deleteRemote || planActions.deleteLocal))
        ? SyncHypotheses.deleteNotExecuted
        : SyncHypotheses.sync,
      location: "engine.execute",
    });
    // #endregion

    // 9. 상태 갱신
    await this.finalizeState(store, result, latestCursor, deletesSkipped);

    const deferredCount = result.deferred.length > 0 ? result.deferred.length : undefined;
    const cursorUpdated = this.lastCursorUpdated;
    this.log("cycle end", {
      durationMs: Date.now() - cycleStartedAt,
      deletesSkipped,
      deferredCount: deferredCount ?? 0,
      pathsSkipped,
      deleteLogRemaining: this.deletedPaths.size,
      deleteLogSample: samplePaths(this.deletedPaths),
    }, { hypothesisId: SyncHypotheses.sync, location: "engine.runCycle" });

    // 10. 사이클 종료 이벤트 + 리포트
    if (ctx) {
      ctx.emit({
        type: "cycle_end",
        ts: Date.now(),
        duration: Date.now() - ctx.startTime,
        stats: plan.stats as unknown as Record<string, number>,
        failed: result.failed.length,
        deferred: result.deferred.length,
      });

      const report = ctx.toJsonl();
      await this.options.onCycleReport?.(report, ctx.cycleId);

      return {
        plan: planWithRetry,
        result,
        deletesSkipped,
        pendingDeletes,
        deferredCount,
        pathsSkipped: pathsSkipped || undefined,
        cycleReport: report,
        diagnostics: this.lastDiagnostics ?? undefined,
        cursorUpdated,
        permanentSkips: this.lastPermanentSkips.length > 0 ? this.lastPermanentSkips : undefined,
      };
    }

    return {
      plan: planWithRetry,
      result,
      deletesSkipped,
      pendingDeletes,
      deferredCount,
      pathsSkipped: pathsSkipped || undefined,
      diagnostics: this.lastDiagnostics ?? undefined,
      cursorUpdated,
      permanentSkips: this.lastPermanentSkips.length > 0 ? this.lastPermanentSkips : undefined,
    };
  }

  /**
   * Persist lastFetchedCursor after a deferred-deletes manual run.
   * Caller must clear deferCursorUpdate first; finalizeState still refuses
   * when the delete log / failures would leave sync incomplete.
   */
  async commitDeferredCursor(): Promise<void> {
    if (!this.lastFetchedCursor) return;
    await this.finalizeState(
      this.deps.store,
      { succeeded: [], failed: [], deferred: [] },
      this.lastFetchedCursor,
      0,
    );
  }

  /**
   * Execute a delete-only plan held from a deferDeletes cycle.
   * Clears succeeded intents from the delete log and may advance the cursor
   * when deferCursorUpdate is false and finalize conditions pass.
   */
  async executeDeletePlan(
    deleteItems: SyncPlanItem[],
    signal?: AbortSignal,
  ): Promise<SyncResult> {
    const { fs, remote, store } = this.deps;
    if (deleteItems.length === 0) {
      return { succeeded: [], failed: [], deferred: [] };
    }

    this.attachAbortSignal(signal);
    try {
      signal?.throwIfAborted();
      const deletePlan: SyncPlan = {
        items: deleteItems,
        stats: {
          ...emptySyncPlanStats(),
          deleteLocal: deleteItems.filter((i) => i.action.type === "deleteLocal").length,
          deleteRemote: deleteItems.filter((i) => i.action.type === "deleteRemote").length,
        },
      };

      // Path-guard deletes here — they were skipped during the deferred content cycle.
      let planToRun = deletePlan;
      const pathGuard = checkPathGuard(planToRun, this.options.strictLocalPaths ?? false);
      if (!pathGuard.passed) {
        planToRun = pathGuard.filteredPlan;
        this.log("executeDeletePlan: path guard filtered deletes", {
          blocked: pathGuard.issues.length,
          remaining: planToRun.items.length,
        }, { hypothesisId: SyncHypotheses.guardSkip, location: "engine.executeDeletePlan" });
      }

      if (planToRun.items.length === 0) {
        return { succeeded: [], failed: [], deferred: [] };
      }

      let execFailed = 0;
      const result = await executePlan(planToRun, { fs, remote, store }, {
        conflictStrategy: this.options.conflictStrategy,
        conflictResolver: this.options.conflictResolver,
        shouldDeferApply: this.options.shouldDeferApply,
        isFileActive: this.options.isFileActive,
        confirmDeleteLocalWhileOpen: this.options.confirmDeleteLocalWhileOpen,
        reloadOpenFile: this.options.reloadOpenFile,
        deferralTracker: this.options.deferralTracker,
        signal,
        concurrency: this.options.concurrency,
        log: this.options.log,
        // Reuse the cycle remote snapshot so deferred deletes still folder-coalesce.
        existingRemotePathLowers: this.lastExistingRemotePathLowers,
        onProgress: (completed, total) => {
          this.options.onProgress?.(completed, total, execFailed);
        },
        onBeforeDeleteLocal: this.options.onBeforeDeleteLocal,
        strictLocalPaths: this.options.strictLocalPaths,
        onExecItem: (localPath, actionType, event, ok, error) => {
          if (event === "start") {
            this.options.onActivityPath?.(localPath);
          }
          if (event === "end" && !ok) {
            execFailed++;
          }
          this.options.onExecItem?.(localPath, actionType, event, ok, error);
        },
      });

      const cursor =
        this.lastFetchedCursor
        ?? (await store.getMeta("cursor"))
        ?? "";
      // deletesSkipped=0: caller already decided approve vs skip before calling.
      await this.finalizeState(store, result, cursor, 0);
      return result;
    } finally {
      this.attachAbortSignal(undefined);
    }
  }

  // ── private helpers ──

  private filterRemoteMapByScope(map: Map<string, RemoteEntry>): void {
    for (const key of [...map.keys()]) {
      const entry = map.get(key)!;
      const path = entry.pathDisplay || entry.pathLower;
      if (!this.pathInScope(path)) {
        map.delete(key);
      }
    }
  }

  private attachLocalScanCallback(cb: LocalFileScanCallback | null): void {
    if (this.deps.fs instanceof VaultAdapter) {
      this.deps.fs.onLocalFileScanned = cb;
    }
  }

  private attachLocalScanProgress(
    cb: ((completed: number, total: number) => void) | null,
  ): void {
    if (this.deps.fs instanceof VaultAdapter) {
      this.deps.fs.onLocalScanProgress = cb;
    }
  }

  /** Local file list for planning — conflict copies are ordinary sync targets (G1). */
  private collectLocalFiles(files: import("../types").FileInfo[]): import("../types").FileInfo[] {
    const conflictCopyCount = files.filter((f) => isConflictFile(f.path)).length;
    if (conflictCopyCount > 0) {
      logRule(this.options.log, SyncRules.R3, "including conflict copies in local scan", {
        conflictCopyCount,
        syncsConflictCopies: true,
      }, { level: "debug", location: "engine.collectLocalFiles" });
      logTemp(this.options.log, "P2", "local scan includes conflict copies", {
        conflictCopyCount,
      }, { location: "engine.collectLocalFiles" });
    }
    return files;
  }

  /** cursor 기반 원격 delta 수집 (cursor 만료 시 전체 재스캔) */
  private async fetchRemoteDeltas(
    store: import("../adapters/interfaces").SyncStateStore,
    remote: import("../adapters/interfaces").RemoteStorage,
    signal?: AbortSignal,
    ctx?: CycleContext,
  ): Promise<{
    deltaEntries: RemoteEntry[];
    latestCursor: string;
    inScopeDeltaCount: number;
    usedFullListing: boolean;
  }> {
    let cursor = await store.getMeta("cursor");
    const scopeFp = this.options.persistentScopeFingerprint;
    if (scopeFp) {
      const storedFp = parseScopeFingerprint(await store.getMeta("cursorScopeFingerprint"));
      if (didScopeWiden(storedFp, scopeFp)) {
        logTemp(this.options.log, "P3", "scope widened — resetting Dropbox cursor", {
          previous: storedFp,
          next: scopeFp,
        }, { location: "engine.fetchRemoteDeltas" });
        await store.setMeta("cursor", "");
        cursor = null;
      }
    }

    let usedFullListing = !cursor;
    const fetchStart = Date.now();
    let changes;
    try {
      changes = await remote.listChanges(cursor ?? undefined);
    } catch (e) {
      if (e instanceof DropboxCursorResetError && cursor) {
        ctx?.emit({ type: "cursor_reset", ts: Date.now(), oldCursor: cursor });
        await store.setMeta("cursor", "");
        cursor = null;
        usedFullListing = true;
        changes = await remote.listChanges();
      } else {
        throw e;
      }
    }

    let deltaEntries = [...changes.entries];
    let latestCursor = changes.cursor;
    let hasMore = changes.hasMore;
    let loggedInScope = 0;
    for (const entry of changes.entries) {
      const path = entry.pathDisplay || entry.pathLower;
      if (!this.pathInScope(path)) continue;
      loggedInScope++;
      const tag = entry.deleted ? "deleted" : "file";
      this.liveReport?.line(`\`${entry.pathDisplay}\` (${tag}, rev ${entry.rev ?? "—"})`);
    }

    ctx?.emit({
      type: "remote_fetch",
      ts: Date.now(),
      deltaCount: deltaEntries.length,
      cursor: latestCursor,
      hasMore,
      duration: Date.now() - fetchStart,
    });

    while (hasMore) {
      signal?.throwIfAborted();
      const pageStart = Date.now();
      const more = await remote.listChanges(latestCursor);
      for (const entry of more.entries) {
        const path = entry.pathDisplay || entry.pathLower;
        if (!this.pathInScope(path)) continue;
        loggedInScope++;
        const tag = entry.deleted ? "deleted" : "file";
        this.liveReport?.line(`\`${entry.pathDisplay}\` (${tag}, rev ${entry.rev ?? "—"})`);
      }
      deltaEntries = deltaEntries.concat(more.entries);
      latestCursor = more.cursor;
      hasMore = more.hasMore;
      ctx?.emit({
        type: "remote_fetch",
        ts: Date.now(),
        deltaCount: more.entries.length,
        cursor: latestCursor,
        hasMore,
        duration: Date.now() - pageStart,
      });
    }

    return { deltaEntries, latestCursor, inScopeDeltaCount: loggedInScope, usedFullListing };
  }

  /**
   * Merge delta into remote state. When usedFullListing (G28), replace from the
   * listing for covered paths — do not seed-merge from base.
   */
  private buildFullRemoteState(
    baseEntries: import("../types").SyncEntry[],
    deltaEntries: RemoteEntry[],
    usedFullListing: boolean,
  ): Map<string, RemoteEntry> {
    const fullRemoteMap = new Map<string, RemoteEntry>();

    if (!usedFullListing) {
      for (const base of baseEntries) {
        if (base.baseRemoteHash && base.rev) {
          fullRemoteMap.set(base.pathLower, {
            pathLower: base.pathLower,
            pathDisplay: base.basePathDisplay ?? base.localPath,
            hash: base.baseRemoteHash,
            serverModified: base.lastSynced,
            rev: base.rev,
            size: 0,
            deleted: false,
          });
        }
      }
    }

    for (const entry of deltaEntries) {
      if (entry.deleted) {
        fullRemoteMap.delete(entry.pathLower);
      } else if (entry.isFolder) {
        fullRemoteMap.set(entry.pathLower, entry);
      } else {
        fullRemoteMap.set(entry.pathLower, entry);
      }
    }

    // Exclude patterns only — conflict copies remain in the remote map (G1).
    const excludePatterns = this.options.excludePatterns ?? [];
    let conflictCopyCount = 0;
    for (const key of fullRemoteMap.keys()) {
      if (isExcluded(key, excludePatterns.map((p) => p.toLowerCase()))) {
        fullRemoteMap.delete(key);
      } else if (isConflictFile(key)) {
        conflictCopyCount++;
      }
    }
    if (conflictCopyCount > 0) {
      logRule(this.options.log, SyncRules.R3, "including conflict copies in remote map", {
        conflictCopyCount,
        syncsConflictCopies: true,
      }, { level: "debug", location: "engine.buildFullRemoteState" });
      logTemp(this.options.log, "P2", "remote map includes conflict copies", {
        conflictCopyCount,
      }, { location: "engine.buildFullRemoteState" });
    }

    if (usedFullListing) {
      logTemp(this.options.log, "P3", "authoritative full listing — remote map not base-seeded", {
        deltaEntries: deltaEntries.length,
        deletedInDelta: deltaEntries.filter((e) => e.deleted).length,
        inScopeAfterMerge: fullRemoteMap.size,
      }, { location: "engine.buildFullRemoteState" });
    }

    return fullRemoteMap;
  }

  /** base에 있지만 로컬에 없는 파일 → 삭제 의도 보완 (vault 이벤트 누락 안전망) */
  private inferMissingDeletes(
    localFiles: import("../types").FileInfo[],
    fullRemoteMap: Map<string, RemoteEntry>,
    baseEntries: import("../types").SyncEntry[],
  ): { count: number; sample: string[]; skippedPluginInfer: number; skippedNotesInfer: number } {
    const localPathSet = new Set(localFiles.map((f) => f.pathLower));
    const sample: string[] = [];
    let count = 0;
    let skippedPluginInfer = 0;
    let skippedNotesInfer = 0;

    const deferInfer = shouldDeferInferredDeletes(this.lastScanVouched);

    // Drop prior catch-up intents when the scan is not vouched (G22).
    // Vault delete/rename events (source "event") are kept.
    if (deferInfer) {
      for (const pathLower of [...this.deletedPaths]) {
        if (this.deleteIntentSources.get(pathLower) === "event") continue;
        this.deletedPaths.delete(pathLower);
        this.deleteIntentSources.delete(pathLower);
      }
    }

    for (const base of baseEntries) {
      if (base.entryKind === "folder") continue;
      const section = classifyVaultPath(base.localPath, this.configDir);
      if (deferInfer) {
        if (
          !localPathSet.has(base.pathLower) &&
          !this.deletedPaths.has(base.pathLower) &&
          fullRemoteMap.has(base.pathLower)
        ) {
          if (section === "plugins") skippedPluginInfer++;
          else if (section === "notes") skippedNotesInfer++;
          else skippedNotesInfer++;
        }
        continue;
      }
      if (
        !localPathSet.has(base.pathLower) &&
        !this.deletedPaths.has(base.pathLower) &&
        fullRemoteMap.has(base.pathLower)
      ) {
        this.deletedPaths.add(base.pathLower);
        this.deleteIntentSources.set(base.pathLower, "inferred");
        count++;
        if (sample.length < 8) {
          sample.push(base.localPath);
        }
        if (hasNestedOtherFilesPath(base.pathLower) || hasNestedOtherFilesPath(base.localPath)) {
          this.log("inferred delete with nested Files/Other/Files path", {
            pathLower: base.pathLower,
            localPath: base.localPath,
            inRemote: fullRemoteMap.has(base.pathLower),
            source: "inferred",
          }, { hypothesisId: SyncHypotheses.pathShape, location: "engine.inferMissingDeletes" });
        }
      }
    }
    return { count, sample, skippedPluginInfer, skippedNotesInfer };
  }

  /** 삭제 가드 적용 → 실행할 plan과 스킵 수 반환 */
  private async applyDeleteGuard(
    plan: SyncPlan,
    ctx?: CycleContext,
  ): Promise<{ planToExecute: SyncPlan; deletesSkipped: number }> {
    const threshold = this.options.deleteThreshold ?? 5;
    const guard = checkDeleteGuard(
      plan,
      threshold,
      this.options.deleteProtection ?? false,
      this.options.log,
    );

    ctx?.emit({
      type: "delete_guard",
      ts: Date.now(),
      deleteCount: guard.deleteItems.length,
      threshold,
      passed: guard.passed,
    });

    const deleteRemote = guard.deleteItems.filter((i) => i.action.type === "deleteRemote").length;
    const deleteLocal = guard.deleteItems.filter((i) => i.action.type === "deleteLocal").length;
    if (this.lastDiagnostics && guard.deleteItems.length > 0) {
      this.lastDiagnostics.deleteGuard = {
        triggered: true,
        totalDeletes: guard.deleteItems.length,
        deleteRemote,
        deleteLocal,
        threshold,
        passed: guard.passed,
        skipped: guard.passed ? undefined : guard.deleteItems.length,
      };
    }

    if (guard.passed) {
      this.log("delete guard passed", {
        deleteCount: guard.deleteItems.length,
        threshold,
        enabled: this.options.deleteProtection ?? false,
        deleteRemote,
        deleteLocal,
      }, { hypothesisId: SyncHypotheses.guardSkip, location: "engine.applyDeleteGuard" });
      return { planToExecute: plan, deletesSkipped: 0 };
    }

    if (this.options.onDeleteGuardTriggered) {
      const approved = await this.options.onDeleteGuardTriggered(guard);
      // #region agent log
      this.log("delete guard user decision", {
        approved,
        deleteCount: guard.deleteItems.length,
        threshold,
        deleteRemote,
        deleteLocal,
        sample: samplePaths(guard.deleteItems.map((i) => `${i.action.type}:${i.localPath}`)),
      }, { hypothesisId: SyncHypotheses.guardSkip, location: "engine.applyDeleteGuard" });
      // #endregion
      if (approved) {
        return { planToExecute: plan, deletesSkipped: 0 };
      }
    }

    const skipped = guard.deleteItems.length;
    if (this.lastDiagnostics?.deleteGuard) {
      this.lastDiagnostics.deleteGuard.skipped = skipped;
    }
    this.log("delete guard skipped deletions", {
      skipped,
      threshold,
      sample: samplePaths(guard.deleteItems.map((i) => i.localPath)),
    }, { hypothesisId: SyncHypotheses.guardSkip, location: "engine.applyDeleteGuard" });
    return { planToExecute: guard.filteredPlan, deletesSkipped: skipped };
  }

  /** cursor 갱신 + 성공한 삭제 항목 정리 + retry-set maintenance (G27). */
  private async finalizeState(
    store: import("../adapters/interfaces").SyncStateStore,
    result: SyncResult,
    latestCursor: string,
    deletesSkipped: number,
  ): Promise<void> {
    const deleteLogBefore = this.deletedPaths.size;

    // Clear executed deletes before the cursor decision so a later multi-section
    // cycle cannot advance the cursor while an earlier section still has skips pending.
    let deletesClearedFromLog = 0;
    for (const item of result.succeeded) {
      // Deletes clear intents; downloads that restored a locally-deleted path
      // (plan-time or folder-verify hash rescue) must clear too or the cursor stalls.
      const clearsDeleteIntent =
        item.action.type === "deleteRemote"
        || item.action.type === "deleteLocal"
        || item.action.type === "download";
      if (clearsDeleteIntent) {
        if (this.deletedPaths.delete(item.pathLower)) {
          deletesClearedFromLog++;
        }
        this.deleteIntentSources.delete(item.pathLower);
      }
      this.options.deferralTracker?.clear(item.localPath);
    }

    const pendingDeleteLog = this.countInScopePendingDeletes();
    const canUpdateCursor =
      !this.options.deferCursorUpdate
      && deletesSkipped === 0
      && result.deferred.length === 0
      && pendingDeleteLog === 0;

    // G27: checkpoint cursor even when some items failed; failures live in retrySet.
    if (canUpdateCursor) {
      await store.setMeta("cursor", latestCursor);
      if (this.options.persistentScopeFingerprint) {
        await store.setMeta(
          "cursorScopeFingerprint",
          serializeScopeFingerprint(this.options.persistentScopeFingerprint),
        );
      }
    }

    const previousRetry = parseRetrySet(await store.getMeta(RETRY_SET_META_KEY));
    const nextRetry = buildRetrySetAfterCycle(previousRetry, result);
    if (nextRetry.length > 0) {
      await store.setMeta(RETRY_SET_META_KEY, serializeRetrySet(nextRetry));
      logTemp(this.options.log, "P4", "updated retry set after cycle", {
        size: nextRetry.length,
        sample: samplePaths(nextRetry.map((entry) => entry.localPath)),
      }, { location: "engine.finalizeState" });
    } else if (previousRetry.length > 0) {
      await store.setMeta(RETRY_SET_META_KEY, serializeRetrySet([]));
    }

    const previousPermanent = parsePermanentSkipSet(await store.getMeta(PERMANENT_SKIP_META_KEY));
    const nextPermanent = mergePermanentSkipAfterCycle(previousPermanent, result);
    if (nextPermanent.length > 0) {
      await store.setMeta(PERMANENT_SKIP_META_KEY, serializePermanentSkipSet(nextPermanent));
      logTemp(this.options.log, "P6", "updated permanent skip set after cycle", {
        size: nextPermanent.length,
        sample: samplePaths(nextPermanent.map((entry) => entry.localPath)),
      }, { location: "engine.finalizeState" });
    } else if (previousPermanent.length > 0) {
      await store.setMeta(PERMANENT_SKIP_META_KEY, serializePermanentSkipSet([]));
    }

    this.lastPermanentSkips = nextPermanent;

    this.lastCursorUpdated = canUpdateCursor;

    // #region agent log
    this.log("finalize state", {
      cursorUpdated: canUpdateCursor,
      deferCursorUpdate: !!this.options.deferCursorUpdate,
      failed: result.failed.length,
      deferred: result.deferred.length,
      deletesSkipped,
      pendingDeleteLog,
      retrySetSize: nextRetry.length,
      blockReasons: [
        ...(this.options.deferCursorUpdate ? ["deferCursorUpdate"] : []),
        ...(deletesSkipped > 0 ? [`deletesSkipped:${deletesSkipped}`] : []),
        ...(result.deferred.length > 0 ? [`deferred:${result.deferred.length}`] : []),
        ...(pendingDeleteLog > 0 ? [`pendingDeleteLog:${pendingDeleteLog}`] : []),
      ],
      deleteLogBefore,
      deletesClearedFromLog,
      deleteLogAfter: this.deletedPaths.size,
      latestCursorPrefix: latestCursor.slice(0, 12),
    }, { hypothesisId: SyncHypotheses.cursorStall, location: "engine.finalizeState" });
    // #endregion
  }
}

/** G14: pathCollision items are reported but never executed. */
function stripNonExecutablePlanItems(plan: SyncPlan): SyncPlan {
  const items = plan.items.filter((item) => item.action.type !== "pathCollision");
  if (items.length === plan.items.length) return plan;
  const stats = { ...plan.stats, pathCollision: plan.stats.pathCollision };
  return { items, stats };
}
