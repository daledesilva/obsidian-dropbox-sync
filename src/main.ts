import { Menu, Notice, Platform, Plugin, TFile } from "obsidian";
import {
  DEFAULT_SETTINGS,
  generateVaultInstanceId,
  getDefaultExcludePatterns,
  mergeBuiltInExcludePatterns,
  getEffectiveAppKey,
  getEffectiveRemotePath,
  type PluginSettings,
} from "./settings";
import { DropboxSyncSettingTab } from "./ui/settings-tab";
import { StatusBar } from "./ui/status-bar";
import { ConflictModal } from "./ui/conflict-modal";
import { ConflictCompareModal } from "./ui/conflict-compare-modal";
import { ConfirmModal } from "./ui/confirm-modal";
import { ResurrectionAskModal } from "./ui/resurrection-ask-modal";
import { SyncCancelConfirmModal } from "./ui/sync-cancel-confirm-modal";
import { DeleteConfirmModal } from "./ui/delete-confirm-modal";
import { IncompatiblePathsModal } from "./ui/incompatible-paths-modal";
import { LogViewerModal } from "./ui/log-viewer-modal";
import { SyncStatusModal } from "./ui/sync-status-modal";
import { OnboardingModal } from "./ui/onboarding-modal";
import { FileSyncStatusTracker } from "./sync/file-sync-status";
import { VaultAdapter } from "./adapters/vault-adapter";
import { DropboxAdapter, DropboxAuthError } from "./adapters/dropbox-adapter";
import { IndexedDBStore, migrateLegacyIndexedDbIfNeeded } from "./adapters/indexeddb-store";
import { VaultFileStore } from "./adapters/vault-file-store";
import type {
  ConflictContext,
  DeleteGuardResult,
  PathGuardIssue,
  PathIssueResolution,
  SyncPlan,
  SyncPlanItem,
  SyncResult,
} from "./types";
import { emptySyncPlanStats } from "./types";
import { checkDeleteGuard } from "./sync/guards";
import {
  groupSucceededPathsByAction,
  isLiveProgressActionType,
  mergeActionSummaryParts,
  mergeActionSummaryPaths,
  summarizeActionParts,
  summarizeResultParts,
} from "./sync/sync-reporter";
import { applyPathRenames } from "./sync/path-rename";
import type { RemoteStorage, SyncStateStore } from "./adapters/interfaces";
import { obsidianHttpClient } from "./http-client.plugin";
import { DesktopAuth } from "./auth/desktop-auth";
import { LongpollManager } from "./sync/longpoll";
import { EngineManager } from "./sync/engine-manager";
import { LogManager } from "./log-manager";
import { postCursorDebugLogLine, type CursorDebugLogMeta } from "./debug/cursor-debug-ingest";
import {
  createSyncMonitorLog,
  formatLogPrefix,
  SyncHypotheses,
  SyncLogCategories,
  samplePaths,
} from "./debug/sync-monitor";
import { registerDemoCommands } from "./debug/demo-commands";
import {
  getCursorDebugSessionId,
  getVerboseDecisionLogging,
  getDeviceId,
  getAccessToken,
  getRefreshToken,
  getTokenExpiry,
  initDeviceSettings,
  migrateDeviceCredentialsFromSyncedSettings,
  patchOAuthTokens,
  setOAuthTokens,
  clearOAuthTokens,
  stripSyncedCredentialFields,
} from "./device-settings/device-settings";
import { tryAutoConnect } from "./debug/cursor-debug-discover";
import { applyQaDebugBootstrap } from "./debug/qa-debug-bootstrap";
import { isConflictFile, type SyncEngine } from "./sync/engine";
import { ACTIVE_FILE_DEFERRAL_MS, DeferralTracker } from "./sync/deferral-tracker";
import {
  parseRetrySet,
  RETRY_SET_META_KEY,
} from "./sync/retry-set";
import type { PermanentSkipEntry } from "./sync/permanent-skip";
import { computePersistentScopeFingerprint } from "./sync/scope-fingerprint";
import {
  reloadOpenMarkdownFile,
  shouldDeferApplyForOpenEditors,
} from "./sync/open-editors";

import { fetchFileFromRemote } from "./deep-link";
import {
  buildSyncLogPath,
  getSyncDeviceTypeLabel,
  buildSyncResultFeedback,
  buildSyncSummaryMarkdown,
  setRibbonSyncing,
  writeSyncLogFallback,
  type SyncOutcome,
  type SyncReportInput,
} from "./ui/sync-feedback";
import { SyncLiveReport } from "./ui/sync-live-report";
import { SyncScopeModal } from "./ui/sync-scope-modal";
import {
  isFileExplorerVisible,
  outcomeToSectionState,
  SyncSectionProgress,
  type ProgressSegmentId,
} from "./ui/sync-section-progress";
import {
  SYNC_SCOPE_LABELS,
  classifyVaultPath,
  type VaultSection,
  vaultEventShouldTriggerSync,
  vaultRenameShouldTriggerSync,
} from "./sync/sync-scope";
import { formatDiagnosticsForLog } from "./sync/sync-diagnostics";
import {
  formatBackgroundSectionsLabel,
  getEnabledBackgroundSections,
  getManualSyncToggleDefaults,
  migrateSettings,
  sectionsFromToggles,
} from "./settings";

export default class DropboxSyncPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;
  private statusBar: StatusBar | null = null;
  /** Per-path UI status for the active-file status bar (session-only). */
  private fileSyncStatus = new FileSyncStatusTracker();
  private unsubscribeFileSyncStatus: (() => void) | null = null;
  private sectionProgress: SyncSectionProgress | null = null;
  /**
   * Segment whose explorer fill follows executor onProgress (vault section or
   * trailing "deletions"). Null for quiet background sync.
   */
  private progressSection: ProgressSegmentId | null = null;
  private syncing = false;
  private syncTimerId: number | null = null;
  private abortController: AbortController | null = null;
  onAuthChange: (() => void) | null = null;
  private logger: LogManager | null = null;
  private debounceTimerId: number | null = null;
  /**
   * Last vault create/modify/delete/rename that should reset the quiet window.
   * fireDebouncedSync refuses to start until vaultEventDebounceSec after this.
   */
  private lastVaultEventAt = 0;
  /**
   * Vault activity arrived while syncing — do not arm a mid-cycle timer (that
   * used to fire ~0.5s after sync end). Re-arm a full debounce in sync finally.
   */
  private pendingDebouncedSync = false;
  /** Monotonic id for correlating debounce arm → cancel → fire in debug logs. */
  private debounceArmId = 0;
  private activeDebounceArmId: number | null = null;
  /** Monotonic id for correlating syncNow start → finish. */
  private syncCycleId = 0;
  private activeSyncCycleId: number | null = null;
  // #region agent log
  /** H-editor: keystroke-level activity vs sparse vault "modify" (autosave). */
  private editorChangeCount = 0;
  private editorChangesSinceLastVaultModify = 0;
  private lastEditorChangeAt = 0;
  private lastEditorChangePath: string | null = null;
  private lastEditorChangeLogAt = 0;
  // #endregion
  /** One-shot retry after open/dirty apply deferral (G10) — not the vault-event debounce. */
  private deferredApplyTimerId: number | null = null;
  /** True after vault create/modify/delete/rename hooks are registered (once per load). */
  private vaultEventsRegistered = false;
  private lastSyncTime: number | null = null;
  private lastSyncSummary: string | null = null;
  private ribbonEl: HTMLElement | null = null;
  private conflictIndex = 0;
  private conflictTotal = 0;
  private syncDeletedByEngine = new Set<string>();
  private deleteConfirmModal: DeleteConfirmModal | null = null;
  private incompatiblePathsModal: IncompatiblePathsModal | null = null;
  /** applyPathRenames 중 vault rename → trackDelete 억제 */
  private suppressRenameDeleteTracking = false;
  private lastManualSyncSections: VaultSection[] = sectionsFromToggles(
    getManualSyncToggleDefaults(DEFAULT_SETTINGS),
  );
  private lastManualCreateReport = false;
  /** Scope modal open — ribbon stays idle until user picks an option. */
  private scopeModalOpen = false;
  /**
   * True for Sync now, or after a background sync is promoted because the plan
   * exceeded largeSyncInteractiveThreshold (progress + notices + cancel UX).
   */
  private interactiveUi = false;
  /** Background sections used when promoting mid-cycle to interactive progress. */
  private backgroundPromoteSections: VaultSection[] | null = null;
  /** Per-sync bounded deferral clock (G10) — fresh instance each syncNow. */
  private deferralTracker: DeferralTracker | null = null;
  private openFileDeleteModal: ConfirmModal | null = null;

  get isSyncing(): boolean {
    return this.syncing;
  }

  // ── 모듈 ──
  private auth: DesktopAuth | null = null;
  private longpoll: LongpollManager | null = null;
  private engineMgr: EngineManager | null = null;

  /**
   * Central log entry: gated by debugLoggingEnabled.
   * When on, writes the vault sync-debug file and best-effort POSTs to Cursor
   * Debug ingest when device-local host/path are configured.
   * Optional meta tags (hypothesisId / location / category / ruleId) filter
   * Wi‑Fi NDJSON in Debug sessions.
   *
   * `trace` lines are the per-path planner decision firehose — one line per
   * vault file per cycle — so they are dropped unless the device opts in.
   */
  private log(msg: string, data?: unknown, meta?: CursorDebugLogMeta): Promise<void> {
    if (!this.settings.debugLoggingEnabled) {
      return Promise.resolve();
    }
    if (meta?.level === "trace" && !getVerboseDecisionLogging()) {
      return Promise.resolve();
    }
    // Fire-and-forget Wi‑Fi ingest so local flush is not delayed by requestUrl.
    postCursorDebugLogLine(msg, data, meta);
    if (!this.logger) {
      console.debug("[Dropbox Sync]", formatLogPrefix(meta), msg, data ?? "");
      return Promise.resolve();
    }
    return this.logger.log(`${formatLogPrefix(meta)}${msg}`, data);
  }

  /** Settings "Send test log" — verifies local file + optional Cursor ingest. */
  async sendDebugLogCanary(): Promise<void> {
    await this.log("cursor-debug-ingest canary", {
      deviceId: getDeviceId(),
      platform: Platform.isMobile ? "mobile" : "desktop",
    });
    await this.logger?.flush();
  }

  // ── Lifecycle ──

  async onload(): Promise<void> {
    // Vault-scoped device prefs (Cursor Debug ingest) before any log/ingest reads.
    initDeviceSettings(this.app);

    const credentialsMigrated = await this.loadSettings();

    // Mint device id in device-local storage (G26).
    getDeviceId();

    let needsSave = credentialsMigrated;
    // Stable IndexedDB key — never vault.getName() (folder basename collisions).
    if (!this.settings.vaultInstanceId) {
      this.settings.vaultInstanceId = generateVaultInstanceId();
      needsSave = true;
    }
    const configDir = this.app.vault.configDir;
    const mergedExcludes = mergeBuiltInExcludePatterns(
      this.settings.excludePatterns.length === 0
        ? getDefaultExcludePatterns(configDir)
        : this.settings.excludePatterns,
      configDir,
    );
    if (
      mergedExcludes.length !== this.settings.excludePatterns.length
      || mergedExcludes.some((p, i) => p !== this.settings.excludePatterns[i])
    ) {
      this.settings.excludePatterns = mergedExcludes;
      needsSave = true;
    }

    // Migrate before saveSettings → applySyncState so a background timer cannot
    // open an empty new DB before legacy entries/cursor are copied over.
    if (!Platform.isIosApp) {
      try {
        const migrated = await migrateLegacyIndexedDbIfNeeded(
          this.settings.vaultInstanceId,
          this.app.vault.getName(),
        );
        if (migrated) {
          void this.log("migrated sync state IndexedDB to vaultInstanceId");
        }
      } catch (e) {
        console.error("Failed to migrate legacy sync-state IndexedDB:", e);
      }
    }

    if (needsSave) {
      await this.saveSettings();
    }

    // User-facing debug log lives at the vault root on purpose (not under
    // .obsidian/plugins or an excluded hidden folder): people open/share it from
    // the file list and View logs. Do not "fix" this into plugin-private storage.
    this.logger = new LogManager(
      this.app.vault.adapter,
      () => `sync-debug-${getDeviceId()}.log`,
    );

    // qa:open writes qa-debug-bootstrap.json so Debug + verbose decision logging
    // are on before the first sync — then localhost auto-connect can find the offer.
    const qaBootstrap = await applyQaDebugBootstrap(
      this.app,
      this.settings,
      () => this.saveSettings(),
    );
    if (qaBootstrap.applied) {
      void this.log("qa debug bootstrap applied", {
        debugLoggingEnabled: qaBootstrap.debugLoggingEnabled,
        verboseDecisionLogging: qaBootstrap.verboseDecisionLogging,
        autoConnect: qaBootstrap.autoConnect,
      });
    }

    // Same-computer auto-join when Debug logging is already on at launch.
    // Localhost only — mobile still uses Connect (or a prior cache).
    if (this.settings.debugLoggingEnabled && qaBootstrap.autoConnect !== false) {
      void tryAutoConnect().then((result) => {
        if (result.ok) {
          void this.log("cursor debug ingest auto-connected", {
            via: result.via,
            serverName: result.offer.serverName,
            host: result.offer.host,
            port: result.offer.port,
            sessionId: result.offer.sessionId,
          });
        } else {
          void this.log("cursor debug ingest auto-connect skipped", {
            reason: result.reason,
          });
        }
      });
    }

    this.addSettingTab(new DropboxSyncSettingTab(this.app, this));
    this.statusBar = new StatusBar(this.addStatusBarItem());
    this.unsubscribeFileSyncStatus = this.fileSyncStatus.subscribe(() => {
      this.refreshStatusBarForActiveFile();
    });

    // 커맨드 등록
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.openSyncScopeModal() });
    this.addCommand({ id: "view-logs", name: "View sync logs", callback: () => this.showLogs() });
    this.addCommand({
      id: "toggle-sync",
      name: "Toggle automatic background sync",
      callback: () =>
        this.settings.backgroundSyncEnabled
          ? void this.disableBackgroundSync()
          : void this.enableBackgroundSync(),
    });

    registerDemoCommands(this);

    // Auth (데스크톱)
    this.auth = new DesktopAuth(() => getEffectiveAppKey(this.settings), obsidianHttpClient);
    if (Platform.isDesktop) {
      this.registerObsidianProtocolHandler(
        "dropbox-sync",
        (params) => this.handleAuthCallback(params),
      );
    }

    // Deep link: sync-then-open
    this.registerObsidianProtocolHandler(
      "dropbox-sync-open",
      (params) => { void this.handleOpenFile(params); },
    );

    // UI: 리본 + 상태 바 (use addRibbonIcon callback — addEventListener is unreliable on mobile)
    this.ribbonEl = this.addRibbonIcon("refresh-cw", "Dropbox sync", () => {
      void this.handleRibbonClick();
    });
    this.ribbonEl.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      this.showContextMenu(evt);
    });
    this.statusBar?.onClick(() => this.handleStatusBarClick());
    this.statusBar?.onContextMenu((evt) => this.showContextMenu(evt));
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.refreshStatusBarForActiveFile();
        void this.flushDeferredAppliesAfterLeafChange();
      }),
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.refreshStatusBarForActiveFile();
        void this.flushDeferredAppliesAfterLeafChange();
      }),
    );

    this.app.workspace.onLayoutReady(async () => {
      // Wipe/re-link often sets syncName after first layoutReady — ensureVaultSyncHooks
      // is also called from handleSyncNameRelink / syncNow so events are not skipped.
      await this.ensureVaultSyncHooks();
      this.applySyncState();
      this.refreshStatusBarForActiveFile();
      void this.showOnboardingIfNeeded();
    });
  }

  onunload(): void {
    this.clearSyncTimer();
    this.clearDebounceTimer();
    this.clearDeferredApplyTimer();
    this.longpoll?.stop();
    this.sectionProgress?.destroy();
    this.sectionProgress = null;
    this.unsubscribeFileSyncStatus?.();
    this.unsubscribeFileSyncStatus = null;
    this.fileSyncStatus.destroy();
    this.statusBar?.destroy();
  }

  // ── Settings ──

  async loadSettings(): Promise<boolean> {
    const raw = await this.loadData() as (Partial<PluginSettings> & {
      syncEnabled?: boolean;
      deviceId?: string;
      accessToken?: string;
      refreshToken?: string;
      tokenExpiry?: number;
    }) | null;
    const credentialsMigrated = migrateDeviceCredentialsFromSyncedSettings(
      raw as Record<string, unknown> | null,
    );
    if (credentialsMigrated) {
      stripSyncedCredentialFields((raw ?? {}) as Record<string, unknown>);
    }
    const migrated = migrateSettings(raw);
    this.settings = Object.assign({}, DEFAULT_SETTINGS, migrated);
    if (raw?.syncEnabled !== undefined && raw.backgroundSyncEnabled === undefined) {
      this.settings.backgroundSyncEnabled = raw.syncEnabled;
    }
    return credentialsMigrated;
  }

  async saveSettings(): Promise<void> {
    const payload = { ...this.settings };
    stripSyncedCredentialFields(payload as unknown as Record<string, unknown>);
    await this.saveData(payload);
    this.engineMgr?.reset();
    this.applySyncState();
  }

  resetEngine(): void {
    this.engineMgr?.reset();
  }

  /**
   * G15 / R11: a vault ID change is a re-link — isolate old base, cursor, and delete log.
   * Call after the user confirms in settings; does not modify vault files.
   */
  async handleSyncNameRelink(newSyncName: string): Promise<void> {
    await this.engineMgr?.clearSyncHistory();
    this.getOrCreateEngine();
    const store = this.engineMgr?.store;
    if (store) {
      await store.setMeta("linkedSyncName", newSyncName);
    }
    this.resetEngine();
    // Fresh link after wipe: layoutReady already ran without syncName, so vault
    // event hooks were never registered — wire them now or local edits only hit
    // the periodic syncInterval fallback.
    await this.ensureVaultSyncHooks();
    void this.log("re-link — cleared sync base, cursor, and delete log", {
      syncName: newSyncName,
    }, {
      category: SyncLogCategories.cycle,
      ruleId: "R11",
      level: "info",
      location: "main.handleSyncNameRelink",
    });
  }

  /** Detect settings/link drift and ask before continuing with stale cursor/base (G15). */
  private async ensureLinkedFolder(): Promise<boolean> {
    if (!this.settings.syncName) return true;
    this.getOrCreateEngine();
    const store = this.engineMgr?.store;
    if (!store) return true;

    const linked = await store.getMeta("linkedSyncName");
    if (!linked) {
      await store.setMeta("linkedSyncName", this.settings.syncName);
      return true;
    }
    if (linked === this.settings.syncName) return true;

    const confirmed = await new ConfirmModal(
      this.app,
      "Dropbox folder changed",
      `This device was linked to "${linked}" but is now set to "${this.settings.syncName}".`,
      "To sync with the new folder, local sync history for the old link (base, cursor, delete log) must be cleared. Your vault files are not deleted.",
      "Clear and continue",
      "Cancel",
    ).waitForConfirmation();
    if (!confirmed) return false;
    await this.handleSyncNameRelink(this.settings.syncName);
    return true;
  }

  // ── Auth ──

  async startAuth(): Promise<void> {
    await this.auth?.start();
  }

  private async handleAuthCallback(params: Record<string, string>): Promise<void> {
    if (!this.auth) return;
    const tokens = await this.auth.handleCallback(params);
    if (!tokens) return;

    setOAuthTokens(tokens.accessToken, tokens.refreshToken, tokens.expiresAt);
    await this.saveSettings();

    new Notice("Connected to Dropbox!");
    this.onAuthChange?.();
  }

  // ── Deep link: sync-then-open ──

  private async handleOpenFile(params: Record<string, string>): Promise<void> {
    const filePath = params.file ? decodeURIComponent(params.file) : null;
    if (!filePath) {
      new Notice("Dropbox sync: missing 'file' parameter.");
      return;
    }

    if (!getRefreshToken()) {
      new Notice("Dropbox sync: not connected. Open settings to connect first.");
      return;
    }

    // 로컬에 이미 있으면 바로 열기
    const existing = this.app.vault.getAbstractFileByPath(filePath);
    if (existing && existing instanceof TFile) {
      await this.app.workspace.getLeaf().openFile(existing);
      return;
    }

    // Dropbox에서 다운로드
    new Notice(`Fetching "${filePath}" from Dropbox…`);
    await this.log(`deep-link open: ${filePath}`);

    try {
      this.getOrCreateEngine(); // adapter 초기화 보장
      const remote = this.engineMgr?.remote;
      const fs = this.engineMgr?.fs;
      const store = this.engineMgr?.store;
      if (!remote || !fs) {
        new Notice("Dropbox sync: engine not ready. Try again after sync is configured.");
        return;
      }

      const { dropboxContentHashBrowser } = await import("./hash.browser");
      await fetchFileFromRemote(filePath, {
        remote,
        fs,
        store: store ?? null,
        computeHash: dropboxContentHashBrowser,
      });

      // 파일 열기
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (file && file instanceof TFile) {
        await this.app.workspace.getLeaf().openFile(file);
      } else {
        new Notice(`Dropbox Sync: downloaded but could not open "${filePath}".`);
      }
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      await this.log(`deep-link open failed: ${filePath}`, e);
      new Notice(`Dropbox Sync: failed to fetch "${filePath}" — ${msg}`);
    }
  }

  // ── Sync ──

  private async handleRibbonClick(): Promise<void> {
    if (this.syncing) {
      // Same confirm modal as the explorer panel Cancel control.
      await this.confirmAndCancelSync();
      return;
    }
    if (this.scopeModalOpen) return;
    await this.openSyncScopeModal();
  }

  async openSyncScopeModal(): Promise<void> {
    if (!getRefreshToken()) {
      new Notice("Dropbox sync: not connected. Open settings to connect.");
      return;
    }
    if (!this.settings.syncName) {
      new Notice("Dropbox sync: set a vault ID in settings first.");
      return;
    }
    this.scopeModalOpen = true;
    setRibbonSyncing(this.ribbonEl, false);
    new SyncScopeModal(this.app, this).open();
  }

  /** Called when the scope modal closes (including after a scope is chosen). */
  onSyncScopeModalClosed(): void {
    this.scopeModalOpen = false;
  }

  /** Shared by ribbon stop and explorer panel Cancel. */
  private async confirmAndCancelSync(): Promise<void> {
    const shouldCancel = await new SyncCancelConfirmModal(this.app).waitForConfirmation();
    if (shouldCancel) {
      this.cancelCurrentSync();
    }
  }

  cancelCurrentSync(): void {
    if (!this.syncing) return;
    this.abortController?.abort();
    // Do not clear syncing/ribbon here — syncNow's finally owns cleanup so a
    // follow-up sync cannot start while an aborted cycle is still unwinding
    // (which previously left the ribbon spinning or cleared a newer run's spin).
    // In-flight file icons go back to pending until a later run finishes.
    this.fileSyncStatus.requeueSyncing("Sync stopping — file not fully synced yet");
    new Notice("Dropbox Sync: stopping…", 2000);
  }

  async syncNow(options?: {
    manual?: boolean;
    sections?: VaultSection[];
    createReport?: boolean;
    /** Who requested this cycle — for debounce/trigger tracing only. */
    trigger?: string;
  }): Promise<void> {
    const manual = options?.manual ?? false;
    const trigger = options?.trigger ?? (manual ? "manual" : "unspecified");
    let scopeLabel: string;
    let manualSections: VaultSection[] | undefined;
    let createReport = false;
    if (manual) {
      const sections = options?.sections ?? this.lastManualSyncSections;
      if (sections.length === 0) {
        new Notice("Dropbox sync: at least one section must be enabled.");
        return;
      }
      this.lastManualSyncSections = sections;
      createReport = options?.createReport ?? this.lastManualCreateReport;
      this.lastManualCreateReport = createReport;
      manualSections = sections;
      scopeLabel = formatBackgroundSectionsLabel(sections);
    } else {
      const sections = getEnabledBackgroundSections(this.settings);
      scopeLabel = formatBackgroundSectionsLabel(sections);
    }
    // #region agent log
    if (this.syncing) {
      this.debounceTrace("syncNow SKIP already syncing", {
        trigger,
        ...this.debounceSnapshot(),
      });
      return;
    }
    // #endregion
    if (!this.settings.syncName) {
      new Notice("Dropbox sync: set a vault ID in settings first.");
      return;
    }
    if (!getRefreshToken()) {
      new Notice("Dropbox sync: not connected. Open settings to connect.");
      return;
    }
    await this.ensureVaultSyncHooks();
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      await this.log("sync skipped: offline");
      return;
    }
    if (!(await this.ensureLinkedFolder())) {
      new Notice("Dropbox sync cancelled — link change not confirmed.");
      return;
    }

    const startedAt = Date.now();
    this.syncing = true;
    this.syncCycleId += 1;
    this.activeSyncCycleId = this.syncCycleId;
    // #region agent log
    this.debounceTrace("syncNow START", {
      trigger,
      syncCycleId: this.activeSyncCycleId,
      scopeLabel,
      ...this.debounceSnapshot(),
    });
    // #endregion
    // Manual always gets interactive UX; background may promote after plan is ready.
    this.interactiveUi = manual;
    this.backgroundPromoteSections = manual
      ? null
      : getEnabledBackgroundSections(this.settings);
    this.clearSyncTimer();
    this.clearDeferredApplyTimer();
    this.abortController = new AbortController();
    this.longpoll?.stop();
    if (!this.scopeModalOpen) {
      setRibbonSyncing(this.ribbonEl, true);
    }
    let cursorUpdated = false;
    let needsResyncAfterRename = false;
    let outcome: SyncOutcome = "up_to_date";
    let endMessage = "Dropbox Sync: up to date";
    let noticeDuration = 4000;
    let plan: SyncPlan | undefined;
    let result: SyncResult | undefined;
    let deletesSkipped: number | undefined;
    let deferredCount: number | undefined;
    let pathsSkipped: number | undefined;
    let errorMessage: string | undefined;
    let diagnostics: import("./sync/sync-diagnostics").SyncCycleDiagnostics | undefined;
    let liveReport: SyncLiveReport | null = null;
    let currentManualSection: VaultSection | null = null;

    if (manual && createReport) {
      try {
        liveReport = await SyncLiveReport.open(this.app, {
          startedAt,
          deviceId: getDeviceId(),
          deviceType: getSyncDeviceTypeLabel(),
          version: this.manifest.version,
          scope: scopeLabel,
        });
      } catch (e) {
        console.error("[Dropbox Sync] sync log open failed", e);
        void this.log("live sync report open failed", e);
      }
    }

    void this.log(`sync started (v${this.manifest.version}, scope: ${scopeLabel})`, {
      manual,
      platform: Platform.isMobile ? "mobile" : "desktop",
      isIos: Platform.isIosApp,
      deleteProtection: this.settings.deleteProtection,
      deleteThreshold: this.settings.deleteThreshold,
      backgroundSyncEnabled: this.settings.backgroundSyncEnabled,
    }, { hypothesisId: SyncHypotheses.sync, location: "main.syncNow" });

    try {
      // Manual progress footer must mount before prune/scan work — a large delete
      // log (thousands of paths) made prune take so long the ribbon spun with no panel.
      if (manual && manualSections && manualSections.length > 0) {
        this.sectionProgress?.destroy();
        this.sectionProgress = new SyncSectionProgress(this.app, () => {
          this.cancelCurrentSync();
        });
        this.sectionProgress.show(manualSections);
        this.sectionProgress.markScanning(manualSections[0]);
      }

      const engine = this.getOrCreateEngine();
      // Refresh callbacks/settings each cycle so log + delete guard stay current.
      engine.applyOptions(this.createEngineOptions());
      engine.setLiveReport(liveReport);
      // Fresh coalesce snapshot per sync — sections union into it, never inherit a prior run.
      engine.resetCoalesceRemoteSnapshot();
      const configDir = this.app.vault.configDir;
      const pruneStartedAt = Date.now();
      const prunedDeletes = await this.pruneStaleDeleteLog(engine);
      void this.log("delete-log before cycle", {
        pending: engine.getDeleteLog().length,
        pruned: prunedDeletes,
        sample: samplePaths(engine.getDeleteLog()),
      }, { hypothesisId: SyncHypotheses.reInferDeletes, location: "main.syncNow" });
      if (prunedDeletes > 0) {
        liveReport?.line(`pruned ${prunedDeletes} stale delete-log entry/entries`);
        this.engineMgr?.persistDeleteLog();
      }
      this.conflictIndex = 0;
      this.conflictTotal = 0;
      // Persist across syncNow cycles so G10/G19's 60s open-file bound can expire;
      // recreating each run reset the clock and deferred forever while focused.
      if (!this.deferralTracker) {
        this.deferralTracker = new DeferralTracker();
      }

      // Manual: one section at a time (notes → settings → plugins → workspaces) with
      // explorer progress segments. Deletes are deferred to a trailing Deletions
      // segment so confirmations run back-to-back after non-delete work finishes.
      // Background keeps a single multi-section cycle unless the plan exceeds
      // largeSyncInteractiveThreshold (then progress UI attaches).
      if (manual && manualSections && manualSections.length > 0) {
        // Created before prune above — local binding keeps the loop null-safe for tsc.
        const sectionProgress = this.sectionProgress;
        if (!sectionProgress) {
          throw new Error("Manual sync progress panel was not initialized");
        }
        const aggregatedSucceeded: SyncResult["succeeded"] = [];
        const aggregatedFailed: SyncResult["failed"] = [];
        const aggregatedDeferredItems: SyncResult["deferred"] = [];
        let aggregatedDeletesSkipped = 0;
        let aggregatedPathsSkipped = 0;
        let lastPermanentSkips: PermanentSkipEntry[] | undefined;
        let lastPlan: SyncPlan | undefined;
        let lastDiagnostics: typeof diagnostics;
        /** Per-section deletes held until the trailing Deletions progress segment. */
        const pendingDeletesBySection: { section: VaultSection; items: SyncPlanItem[] }[] = [];

        // Hold cursor for the whole content pass — commit after deletions (or immediately
        // when no deletes were deferred).
        engine.setDeferDeletes(true);
        engine.setDeferCursorUpdate(true);

        for (let i = 0; i < manualSections.length; i++) {
          const section = manualSections[i];
          currentManualSection = section;
          this.progressSection = section;
          engine.setSyncSections([section], configDir);
          sectionProgress.markScanning(section);
          sectionProgress.notifySegmentTransition(
            null,
            `${SYNC_SCOPE_LABELS[section]}: Scanning changes…`,
          );
          liveReport?.line(`## ${SYNC_SCOPE_LABELS[section]}`);
          // Progress lives in the explorer panel — status bar stays a plain "syncing" state.

          const cycleResult = await engine.runCycle(this.abortController.signal);
          lastPlan = cycleResult.plan;
          lastDiagnostics = cycleResult.diagnostics;
          aggregatedSucceeded.push(...cycleResult.result.succeeded);
          aggregatedFailed.push(...cycleResult.result.failed);
          aggregatedDeferredItems.push(...cycleResult.result.deferred);
          aggregatedDeletesSkipped += cycleResult.deletesSkipped ?? 0;
          aggregatedPathsSkipped += cycleResult.pathsSkipped ?? 0;
          if (cycleResult.permanentSkips?.length) {
            lastPermanentSkips = cycleResult.permanentSkips;
          }

          const sectionPending = cycleResult.pendingDeletes ?? [];
          if (sectionPending.length > 0) {
            pendingDeletesBySection.push({ section, items: sectionPending });
            // Show Deletions as soon as any section plans deletes.
            sectionProgress.ensureDeletionsSegment();
          }

          await this.log(
            `section ${section}: plan ${cycleResult.plan.items.length}, ok ${cycleResult.result.succeeded.length}, fail ${cycleResult.result.failed.length}, pendingDeletes ${sectionPending.length}`,
          );
          if (cycleResult.diagnostics) {
            await this.log(`sync diagnostics (${section})`, formatDiagnosticsForLog(cycleResult.diagnostics));
          }

          if (cycleResult.pathRenamesApplied) {
            sectionProgress.markResult(section, "partial", "Renamed — resyncing");
            sectionProgress.notifySegmentTransition(
              `${SYNC_SCOPE_LABELS[section]}: Renamed — resyncing`,
              null,
            );
            sectionProgress.finishSegmentNotices();
            needsResyncAfterRename = true;
            outcome = "renamed_resync";
            endMessage = "Dropbox Sync: files renamed. Syncing again…";
            noticeDuration = 5000;
            this.lastSyncSummary = "renamed — resyncing";
            this.fileSyncStatus.applySyncResult(cycleResult.result);
            engine.setDeferDeletes(false);
            engine.setDeferCursorUpdate(false);
            return;
          }

          // Non-delete feedback only — trash icons appear after the Deletions phase.
          const sectionFeedback = buildSyncResultFeedback(
            cycleResult.result,
            cycleResult.deletesSkipped,
            cycleResult.pathsSkipped,
            cycleResult.permanentSkips,
            cycleResult.resurrectionDeferred,
          );
          sectionProgress.markResult(
            section,
            outcomeToSectionState(sectionFeedback.outcome),
            sectionFeedback.summary,
            {
              conflictPaths: sectionFeedback.conflictPaths,
              summaryParts: sectionFeedback.summaryParts,
              summaryPaths: sectionFeedback.summaryPaths,
            },
          );
          // Hold end text so the next markScanning can combine into one Notice.
          sectionProgress.notifySegmentTransition(
            `${SYNC_SCOPE_LABELS[section]}: ${sectionFeedback.summary}`,
            null,
          );
        }

        // Trailing Deletions: confirm over-threshold sections back-to-back, then execute.
        if (pendingDeletesBySection.length > 0) {
          this.progressSection = "deletions";
          sectionProgress.markActive("deletions");
          sectionProgress.notifySegmentTransition(
            null,
            "Deletions: Confirming…",
          );
          liveReport?.line("## Deletions");

          let deletionFailed = 0;
          let deletionSucceeded = 0;
          let deletionPhaseSkipped = 0;

          for (const { section, items } of pendingDeletesBySection) {
            const sectionLabel = deferredDeleteSectionLabel(section);
            const approved = await this.confirmDeferredSectionDeletes(items, sectionLabel);
            if (!approved) {
              aggregatedDeletesSkipped += items.length;
              deletionPhaseSkipped += items.length;
              liveReport?.line(
                `${sectionLabel}: skipped ${items.length} deletion(s) by protection`,
              );
              await this.log(`deferred deletes skipped (${section})`, {
                count: items.length,
                sample: samplePaths(items.map((i) => i.localPath)),
              }, { hypothesisId: SyncHypotheses.guardSkip, location: "main.deferredDeletes" });
              continue;
            }

            const deleteResult = await engine.executeDeletePlan(
              items,
              this.abortController.signal,
            );
            aggregatedSucceeded.push(...deleteResult.succeeded);
            aggregatedFailed.push(...deleteResult.failed);
            aggregatedDeferredItems.push(...deleteResult.deferred);
            deletionSucceeded += deleteResult.succeeded.length;
            deletionFailed += deleteResult.failed.length;
            this.fileSyncStatus.applySyncResult(deleteResult);

            // Trash icons/paths on the Files/Settings/… detail line only after deletes run.
            const deleteParts = summarizeActionParts(deleteResult.succeeded);
            if (deleteParts.length > 0) {
              const sectionNonDeleteSucceeded = aggregatedSucceeded.filter((item) => {
                if (
                  item.action.type === "deleteLocal"
                  || item.action.type === "deleteRemote"
                ) {
                  return false;
                }
                return classifyVaultPath(item.localPath, configDir) === section;
              });
              // Include section failures so the failed chip survives trash-chip merge.
              const sectionNonDeleteFailed = aggregatedFailed.filter((f) => {
                if (
                  f.item.action.type === "deleteLocal"
                  || f.item.action.type === "deleteRemote"
                ) {
                  return false;
                }
                return classifyVaultPath(f.item.localPath, configDir) === section;
              });
              const sectionChips = summarizeResultParts({
                succeeded: sectionNonDeleteSucceeded,
                failed: sectionNonDeleteFailed,
              });
              const merged = mergeActionSummaryParts(
                sectionChips.summaryParts,
                deleteParts,
              );
              const mergedPaths = mergeActionSummaryPaths(
                sectionChips.summaryPaths,
                groupSucceededPathsByAction(deleteResult.succeeded),
              );
              sectionProgress.updateSummaryParts(section, merged, undefined, mergedPaths);
            }

            liveReport?.line(
              `${sectionLabel}: deleted ${deleteResult.succeeded.length}`
              + (deleteResult.failed.length ? `, ${deleteResult.failed.length} failed` : ""),
            );
          }

          const deletionsState =
            deletionFailed > 0
              ? "failed"
              : deletionPhaseSkipped > 0
                ? "partial"
                : "success";
          // Aggregate delete successes/failures across sections for chip rendering.
          const deletionChipSource = {
            succeeded: aggregatedSucceeded.filter(
              (item) =>
                item.action.type === "deleteLocal" || item.action.type === "deleteRemote",
            ),
            failed: aggregatedFailed.filter(
              (f) =>
                f.item.action.type === "deleteLocal" || f.item.action.type === "deleteRemote",
            ),
          };
          const deletionChips = summarizeResultParts(deletionChipSource);
          const deletionsSummary =
            deletionFailed > 0
              ? `${deletionFailed} failed, ${deletionSucceeded} ok`
              : deletionPhaseSkipped > 0
                ? `${deletionSucceeded} deleted, ${deletionPhaseSkipped} skipped`
                : deletionSucceeded > 0
                  ? `${deletionSucceeded} deleted`
                  : "skipped";
          sectionProgress.markResult("deletions", deletionsState, deletionsSummary, {
            summaryParts: deletionChips.summaryParts,
            summaryPaths: deletionChips.summaryPaths,
          });
          sectionProgress.notifySegmentTransition(
            `Deletions: ${deletionsSummary}`,
            null,
          );
        }

        sectionProgress.finishSegmentNotices();
        engine.setDeferDeletes(false);
        engine.setDeferCursorUpdate(false);
        await engine.commitDeferredCursor();
        this.engineMgr?.persistDeleteLog();

        plan = lastPlan;
        diagnostics = lastDiagnostics;
        result = {
          succeeded: aggregatedSucceeded,
          failed: aggregatedFailed,
          deferred: aggregatedDeferredItems,
        };
        deletesSkipped = aggregatedDeletesSkipped || undefined;
        deferredCount = aggregatedDeferredItems.length || undefined;
        pathsSkipped = aggregatedPathsSkipped || undefined;

        const feedback = this.reportSyncResult(result, deletesSkipped, pathsSkipped, lastPermanentSkips);
        outcome = feedback.outcome;
        endMessage = feedback.endMessage;
        noticeDuration = feedback.noticeDuration;

        cursorUpdated = engine.getLastCursorUpdated();
      } else {
        engine.setDeferDeletes(false);
        engine.setDeferCursorUpdate(false);
        engine.setSyncSections(getEnabledBackgroundSections(this.settings), configDir);
        const cycleResult = await engine.runCycle(this.abortController.signal);
        plan = cycleResult.plan;
        result = cycleResult.result;
        deletesSkipped = cycleResult.deletesSkipped;
        deferredCount = cycleResult.deferredCount;
        pathsSkipped = cycleResult.pathsSkipped;
        diagnostics = cycleResult.diagnostics;

        await this.log(`plan: ${plan.items.length} items, succeeded: ${result.succeeded.length}, failed: ${result.failed.length}, deletesSkipped: ${deletesSkipped ?? 0}, deferred: ${deferredCount ?? 0}, pathsSkipped: ${pathsSkipped ?? 0}`);
        if (diagnostics) {
          await this.log("sync diagnostics", formatDiagnosticsForLog(diagnostics));
        }

        if (cycleResult.pathRenamesApplied) {
          needsResyncAfterRename = true;
          outcome = "renamed_resync";
          endMessage = "Dropbox Sync: files renamed. Syncing again…";
          noticeDuration = 5000;
          this.lastSyncSummary = "renamed — resyncing";
          this.fileSyncStatus.applySyncResult(result);
          return;
        }

        this.engineMgr?.persistDeleteLog();

        if (this.interactiveUi && this.sectionProgress && this.progressSection) {
          const sectionFeedback = buildSyncResultFeedback(
            result,
            deletesSkipped,
            pathsSkipped,
            cycleResult.permanentSkips,
            cycleResult.resurrectionDeferred,
          );
          this.sectionProgress.markResult(
            this.progressSection,
            outcomeToSectionState(sectionFeedback.outcome),
            sectionFeedback.summary,
            {
              conflictPaths: sectionFeedback.conflictPaths,
              summaryParts: sectionFeedback.summaryParts,
              summaryPaths: sectionFeedback.summaryPaths,
            },
          );
          // Remaining promoted segments share the overall outcome for this single cycle.
          for (const section of this.backgroundPromoteSections ?? []) {
            if (section === this.progressSection) continue;
            this.sectionProgress.markResult(
              section,
              outcomeToSectionState(sectionFeedback.outcome),
              sectionFeedback.summary,
              {
                conflictPaths: sectionFeedback.conflictPaths,
                summaryParts: sectionFeedback.summaryParts,
                summaryPaths: sectionFeedback.summaryPaths,
              },
            );
          }
          const progressLabel =
            this.progressSection && this.progressSection !== "deletions"
              ? SYNC_SCOPE_LABELS[this.progressSection]
              : "Sync";
          this.sectionProgress.notifySegmentTransition(
            `${progressLabel}: ${sectionFeedback.summary}`,
            null,
          );
          this.sectionProgress.finishSegmentNotices();
        }

        const feedback = this.reportSyncResult(result, deletesSkipped, pathsSkipped, cycleResult.permanentSkips);
        outcome = feedback.outcome;
        endMessage = feedback.endMessage;
        noticeDuration = feedback.noticeDuration;

        cursorUpdated = cycleResult.cursorUpdated ?? engine.getLastCursorUpdated();
      }
    } catch (e) {
      // Log before UI updates — markInterrupted can throw and would otherwise
      // leave outcome stuck at the initial "up_to_date" (false instant complete).
      const errMsg = e instanceof Error ? e.message : String(e);
      void this.log("sync error", e instanceof Error ? e : { message: errMsg });
      try {
        const eng = this.getOrCreateEngine();
        eng.setDeferDeletes(false);
        eng.setDeferCursorUpdate(false);
      } catch {
        /* engine may be unavailable after clearSyncHistory mid-failure */
      }
      if (e instanceof Error && e.name === "AbortError") {
        try {
          this.sectionProgress?.markInterrupted(
            currentManualSection ?? this.progressSection,
            "Cancelled",
          );
        } catch {
          /* progress UI must not mask abort */
        }
        await this.log("sync aborted");
        outcome = "aborted";
        endMessage = "Dropbox Sync: cancelled";
        noticeDuration = 3000;
        this.fileSyncStatus.requeueSyncing("Sync cancelled — file not fully synced yet");
        return;
      }
      if (e instanceof DropboxAuthError) {
        try {
          this.sectionProgress?.markInterrupted(
            currentManualSection ?? this.progressSection,
            "Auth error",
          );
        } catch {
          /* progress UI must not mask auth errors */
        }
        await this.log("auth error — token revoked", e);
        clearOAuthTokens();
        await this.saveSettings();
        outcome = "auth_error";
        errorMessage = "Token expired";
        endMessage = "Dropbox sync: token expired. Please reconnect in settings.";
        noticeDuration = 8000;
        this.lastSyncSummary = "auth expired";
        this.fileSyncStatus.failSyncing("Dropbox auth expired — reconnect in settings");
        return;
      }
      try {
        this.sectionProgress?.markInterrupted(
          currentManualSection ?? this.progressSection,
          errMsg.slice(0, 80) || "Error",
        );
      } catch {
        /* progress UI must not mask the original sync failure */
      }
      outcome = "error";
      errorMessage = errMsg;
      endMessage = `Dropbox Sync error: ${errorMessage}`;
      noticeDuration = 8000;
      this.lastSyncSummary = "sync failed";
      this.fileSyncStatus.failSyncing("Sync failed for this file");
    } finally {
      const endedAt = Date.now();
      setRibbonSyncing(this.ribbonEl, false);
      // End summary lives in the explorer panel for interactive runs — no sticky Notice.

      const reportInput: SyncReportInput = {
        startedAt,
        endedAt,
        outcome,
        plan,
        result,
        deletesSkipped,
        deferredCount,
        pathsSkipped,
        errorMessage,
        deviceId: getDeviceId(),
        version: this.manifest.version,
        diagnostics,
      };

      const engine = this.getOrCreateEngine();
      engine.setLiveReport(null);
      // Clear manual-run flags so a later background cycle does not inherit them.
      engine.setDeferDeletes(false);
      if (liveReport) {
        await liveReport.finalize(reportInput);
      } else if (manual && createReport) {
        const markdown = buildSyncSummaryMarkdown(reportInput);
        await writeSyncLogFallback(
          this.app,
          buildSyncLogPath(startedAt, getDeviceId(), getSyncDeviceTypeLabel()),
          markdown,
        );
      }

      this.syncing = false;
      this.interactiveUi = false;
      this.backgroundPromoteSections = null;
      this.progressSection = null;
      this.syncDeletedByEngine.clear();
      this.abortController = null;
      // #region agent log
      this.debounceTrace("syncNow FINALLY before follow-ups", {
        trigger,
        syncCycleId: this.activeSyncCycleId,
        outcome,
        durationMs: endedAt - startedAt,
        cursorUpdated,
        needsResyncAfterRename,
        deferredCount: deferredCount ?? 0,
        pendingDeletes: this.engineMgr?.hasPendingDeletes() ?? false,
        ...this.debounceSnapshot(),
      });
      // #endregion
      this.activeSyncCycleId = null;
      // Keep deferralTracker when paths were deferred so the open-file bound continues.
      if (!(deferredCount && deferredCount > 0)) {
        this.deferralTracker = null;
      }
      this.lastSyncTime = endedAt;
      void this.log("sync finished", {
        outcome,
        durationMs: endedAt - startedAt,
        cursorUpdated,
        needsResyncAfterRename,
        deletesSkipped: deletesSkipped ?? 0,
        deferredCount: deferredCount ?? 0,
        pathsSkipped: pathsSkipped ?? 0,
        planItems: plan?.items.length ?? 0,
        succeeded: result?.succeeded.length ?? 0,
        failed: result?.failed.length ?? 0,
        pendingDeleteLog: this.engineMgr?.hasPendingDeletes() ?? false,
        willDebounceForPendingDeletes:
          !!(this.engineMgr?.hasPendingDeletes() && this.settings.backgroundSyncEnabled),
        willRetryDeferredApplies:
          !!(deferredCount && deferredCount > 0 && this.settings.backgroundSyncEnabled),
        willLongpoll: !!(cursorUpdated && this.settings.backgroundSyncEnabled),
        trigger,
      }, { hypothesisId: SyncHypotheses.cursorStall, location: "main.syncNow.finally" });
      await this.logger?.flush();
      // 미소비 삭제가 있으면 후속 싱크 스케줄 (싱크 중 사용자 삭제 처리)
      if (this.engineMgr?.hasPendingDeletes() && this.settings.backgroundSyncEnabled) {
        this.pendingDebouncedSync = false;
        // #region agent log
        this.debounceTrace("finally → scheduleDebounced (pending deletes)", {
          pendingCount: this.getOrCreateEngine().getDeleteLog().length,
        });
        // #endregion
        this.scheduleDebouncedSync("finally:pending-deletes");
      } else if (needsResyncAfterRename) {
        // #region agent log
        this.debounceTrace("finally → syncNow in 200ms (rename resync)", {});
        // #endregion
        window.setTimeout(
          () => void this.syncNow({
            manual: true,
            sections: this.lastManualSyncSections,
            createReport: this.lastManualCreateReport,
            trigger: "finally:rename-resync",
          }),
          200,
        );
      } else if (this.settings.backgroundSyncEnabled) {
        // Mid-cycle vault edits only set pendingDebouncedSync — re-arm a full
        // quiet window here so we never sync ~0.5s after upload while typing.
        if (this.pendingDebouncedSync) {
          this.pendingDebouncedSync = false;
          // #region agent log
          this.debounceTrace("finally → scheduleDebounced (pending vault activity)", {
            msSinceLastVaultEvent: Date.now() - this.lastVaultEventAt,
            debounceSec: this.settings.vaultEventDebounceSec,
          });
          // #endregion
          this.scheduleDebouncedSync("finally:pending-vault-activity");
        }
        // Deferred open-file applies now checkpoint the cursor into retrySet — keep
        // longpoll alive, and also wake when the G10 bound can expire.
        if (deferredCount && deferredCount > 0) {
          // #region agent log
          this.debounceTrace("finally → scheduleDeferredApplyRetry", {
            deferredCount,
          });
          // #endregion
          this.scheduleDeferredApplyRetry();
        }
        if (cursorUpdated) {
          // #region agent log
          this.debounceTrace("finally → longpoll.schedule", { cursorUpdated: true });
          // #endregion
          this.longpoll?.schedule();
        }
      }
      // #region agent log
      this.debounceTrace("finally → rescheduleBackgroundSyncTimer", {
        eligible: this.isBackgroundSyncTimerEligible(),
        syncIntervalSec: this.settings.syncInterval,
      });
      // #endregion
      this.rescheduleBackgroundSyncTimerIfEnabled();
    }
  }

  async enableBackgroundSync(): Promise<void> {
    this.settings.backgroundSyncEnabled = true;
    await this.saveSettings();
  }

  async disableBackgroundSync(): Promise<void> {
    this.longpoll?.stop();
    this.clearDebounceTimer();
    this.clearDeferredApplyTimer();
    this.settings.backgroundSyncEnabled = false;
    await this.saveSettings();
  }

  /** @deprecated Use enableBackgroundSync — does not run a sync cycle. */
  async startSync(): Promise<void> {
    await this.enableBackgroundSync();
  }

  /** @deprecated Use disableBackgroundSync — does not cancel manual sync. */
  async stopSync(): Promise<void> {
    await this.disableBackgroundSync();
  }

  // ── Engine 접근자 (demo-commands 등에서 사용) ──

  getOrCreateEngine(): SyncEngine {
    return this.getEngineManager().getOrCreate();
  }

  getRemoteAdapter(): RemoteStorage | null {
    return this.engineMgr?.remote ?? null;
  }

  getStore(): SyncStateStore | null {
    return this.engineMgr?.store ?? null;
  }

  // ── Remote folder check (settings-tab에서 사용) ──

  async checkRemoteFolder(syncName: string): Promise<number | null> {
    const appKey = getEffectiveAppKey(this.settings);
    if (!appKey || !getAccessToken()) return null;

    try {
      const resp = await obsidianHttpClient({
        url: "https://api.dropboxapi.com/2/files/list_folder",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getAccessToken()}`,
        },
        body: JSON.stringify({ path: `/${syncName}`, recursive: true, limit: 100 }),
      });
      if (resp.status !== 200) return null;
      const data = resp.json as { entries: Array<Record<string, unknown>> };
      return data.entries.filter((e) => e[".tag"] === "file").length;
    } catch {
      return null;
    }
  }

  async readLogs(): Promise<string> {
    return this.logger?.read() ?? "(no logs)";
  }

  /**
   * Settings “Clear sync history”: wipe local sync base/cursor/delete log so the
   * next sync re-downloads like a first install. Does not clear debug settings
   * (debugLoggingEnabled or Cursor Debug ingest). Refuses while a cycle is running.
   */
  async clearSyncHistory(): Promise<void> {
    if (this.syncing) {
      new Notice("Wait for the current sync to finish, then try again.");
      return;
    }
    try {
      await this.getEngineManager().clearSyncHistory();
      void this.log("cleared sync history (store + delete log)");
      new Notice(
        "Sync history cleared. The next sync will treat this device like a new install.",
      );
    } catch (e) {
      console.error("Failed to clear sync history:", e);
      new Notice("Could not clear sync history. Check the logs.");
    }
  }

  // ── Private: Engine ──

  private getEngineManager(): EngineManager {
    if (!this.engineMgr) {
      this.engineMgr = new EngineManager({
        createDeps: () => this.createEngineDeps(),
        getOptions: () => this.createEngineOptions(),
      });

      this.longpoll = new LongpollManager({
        httpClient: obsidianHttpClient,
        getCursor: async () => this.engineMgr?.store?.getMeta("cursor") ?? null,
        isSyncing: () => this.syncing,
        isEnabled: () => this.settings.backgroundSyncEnabled && !!this.engineMgr?.store,
        onChanges: () => {
          // #region agent log
          this.debounceTrace("longpoll onChanges → scheduleDebouncedSync", {
            ...this.debounceSnapshot(),
          });
          // #endregion
          // Debounce so a burst of remote events (and any residual echo) settles
          // with local typing rather than syncing every keystroke mid-upload loop.
          this.scheduleDebouncedSync("longpoll:onChanges");
        },
        log: (msg, data) => {
          // #region agent log
          void this.log(`[debounce-trace] longpoll: ${msg}`, {
            data,
            hypothesisId: "H-debounce-trace",
            ...this.debounceSnapshot(),
          }, { location: "longpoll", hypothesisId: "H-debounce-trace" });
          // #endregion
          return this.log(msg, data);
        },
      });
    }
    return this.engineMgr;
  }

  private createEngineDeps() {
    const syncLog = createSyncMonitorLog((msg, data, meta) => this.log(msg, data, meta));
    const fs = new VaultAdapter(
      this.app.vault,
      this.settings.excludePatterns,
      this.app.fileManager,
      this.app.vault.configDir,
    );
    fs.log = syncLog;
    const remote = new DropboxAdapter({
      httpClient: obsidianHttpClient,
      appKey: getEffectiveAppKey(this.settings),
      remotePath: getEffectiveRemotePath(this.settings),
      getAccessToken,
      getRefreshToken,
      getTokenExpiry: () => getTokenExpiry(),
      onTokenRefreshed: (accessToken, expiresAt) => {
        patchOAuthTokens({ accessToken, tokenExpiry: expiresAt });
        void this.saveSettings();
      },
      log: syncLog,
    });
    // iOS uses vault files; elsewhere IndexedDB keyed by vaultInstanceId.
    const store: SyncStateStore = Platform.isIosApp
      ? new VaultFileStore(this.app.vault)
      : new IndexedDBStore(this.settings.vaultInstanceId);

    return { fs, remote, store };
  }

  /**
   * Attach manual-like progress/notices when a background plan exceeds the threshold.
   * Called mid-cycle after planning so execute still drives the segment fill.
   */
  private promoteBackgroundToInteractive(
    actionCount: number,
    threshold: number,
    planItems?: { action: { type: string } }[],
  ): void {
    this.interactiveUi = true;
    const sections =
      this.backgroundPromoteSections ?? getEnabledBackgroundSections(this.settings);
    void this.log(
      `large background sync: ${actionCount} actions > ${threshold} — interactive UI`,
    );
    this.sectionProgress?.destroy();
    this.sectionProgress = new SyncSectionProgress(this.app, () => {
      this.cancelCurrentSync();
    });
    this.sectionProgress.show(sections);
    const first = sections[0];
    if (first) {
      this.progressSection = first;
      this.sectionProgress.markActive(first);
      // Plan is already known at promote time — seed live chips immediately.
      if (planItems) {
        this.sectionProgress.beginLiveActionProgress(first, planItems);
      }
      this.sectionProgress.notifySegmentTransition(
        null,
        `${SYNC_SCOPE_LABELS[first]}: Syncing…`,
      );
    }
    if (!this.scopeModalOpen) {
      setRibbonSyncing(this.ribbonEl, true);
    }
  }

  private createEngineOptions() {
    const syncLog = createSyncMonitorLog((msg, data, meta) => this.log(msg, data, meta));
    return {
      log: syncLog,
      conflictStrategy: this.settings.conflictStrategy,
      conflictResolver: async (filePath: string, context?: ConflictContext) => {
        this.conflictIndex++;
        const modal = new ConflictModal(this.app, filePath, context, {
          index: this.conflictIndex,
          total: this.conflictTotal,
        });
        return modal.waitForChoice();
      },
      deleteProtection: this.settings.deleteProtection,
      deleteThreshold: this.settings.deleteThreshold,
      // Await the modal so Delete/Skip applies to this cycle. Returning false
      // immediately used to always strip deletes; a later flag+debounce never
      // re-ran reliably (e.g. background sync off), so both choices looked like Skip.
      onDeleteGuardTriggered: async (guard: DeleteGuardResult): Promise<boolean> => {
        if (this.deleteConfirmModal) {
          return false;
        }
        const modal = new DeleteConfirmModal(this.app, guard.deleteItems);
        this.deleteConfirmModal = modal;
        try {
          const remote = guard.deleteItems.filter((i) => i.action.type === "deleteRemote").length;
          const local = guard.deleteItems.filter((i) => i.action.type === "deleteLocal").length;
          const approved = await modal.waitForConfirmation();
          void this.log(
            approved
              ? `delete guard: user approved ${guard.deleteItems.length} deletions`
              : `delete guard: user skipped ${guard.deleteItems.length} deletions`,
            {
              remote,
              local,
              threshold: this.settings.deleteThreshold,
              approved,
              sample: samplePaths(guard.deleteItems.map((i) => i.localPath)),
            },
            { hypothesisId: SyncHypotheses.guardSkip, location: "main.onDeleteGuardTriggered" },
          );
          return approved;
        } finally {
          this.deleteConfirmModal = null;
        }
      },
      isFileActive: (path: string) => shouldDeferApplyForOpenEditors(this.app, path),
      shouldDeferApply: (path: string) => shouldDeferApplyForOpenEditors(this.app, path),
      confirmDeleteLocalWhileOpen: (path: string) => this.confirmDeleteLocalWhileOpen(path),
      reloadOpenFile: (path: string) => reloadOpenMarkdownFile(this.app, path),
      deferralTracker: this.deferralTracker ?? undefined,
      resurrectionResolver: (localPaths: string[]) =>
        new ResurrectionAskModal(this.app, localPaths).waitForChoice(),
      persistentScopeFingerprint: computePersistentScopeFingerprint({
        backgroundSections: getEnabledBackgroundSections(this.settings),
        excludePatterns: this.settings.excludePatterns,
        includeHiddenFilesAndFolders: this.settings.includeHiddenFilesAndFolders,
      }),
      excludePatterns: this.settings.excludePatterns,
      includeHiddenFilesAndFolders: this.settings.includeHiddenFilesAndFolders,
      // Parallel uploads for many-small-file sync; create_folder runs first at ≤2
      // (see executor) because Dropbox write-locks stampede at full concurrency.
      concurrency: 6,
      onConflictCount: (count: number) => {
        this.conflictTotal = count;
        this.conflictIndex = 0;
      },
      onBeforeDeleteLocal: (pathLower: string) => {
        this.syncDeletedByEngine.add(pathLower);
      },
      strictLocalPaths: Platform.isIosApp || Platform.isMobile,
      onPathIssues: (issues: PathGuardIssue[]) => this.handlePathIssues(issues),
      onPathCollisions: (items: SyncPlanItem[]) => {
        for (const item of items) {
          if (item.action.type !== "pathCollision") continue;
          new Notice(
            `Dropbox Sync: "${item.localPath}" is a ${item.action.localKind} locally but a ${item.action.remoteKind} on Dropbox — skipped to avoid data loss.`,
            10_000,
          );
        }
      },
      onPathNotice: (message: string) => {
        new Notice(message, 8000);
      },
      onPlanReady: async (plan: SyncPlan) => {
        // Per-file status bar: every actionable path becomes syncing for this cycle.
        this.fileSyncStatus.markPlanSyncing(plan.items);
        if (this.interactiveUi) {
          // Flip Scanning → Syncing once the plan exists (execute follows).
          if (this.progressSection) {
            this.sectionProgress?.markActive(this.progressSection);
            // Seed upload/download chips with plan totals before the first onProgress tick.
            this.sectionProgress?.beginLiveActionProgress(
              this.progressSection,
              plan.items,
            );
          }
          return;
        }
        const threshold = this.settings.largeSyncInteractiveThreshold ?? 10;
        // plan.items excludes noops — count is the actionable change volume.
        if (plan.items.length <= threshold) return;
        this.promoteBackgroundToInteractive(plan.items.length, threshold, plan.items);
      },
      onExecItem: (localPath: string, actionType: string, event: "start" | "end", ok?: boolean, error?: string) => {
        if (event === "start") {
          this.fileSyncStatus.markSyncing(
            localPath,
            "This file is currently syncing with Dropbox",
          );
          // Live chip modal log: first start = attempt, later starts = retrying.
          if (
            this.progressSection
            && isLiveProgressActionType(actionType)
          ) {
            this.sectionProgress?.recordLiveActionStart(
              this.progressSection,
              actionType,
              localPath,
            );
          }
          return;
        }
        // Grow live upload/download chips + open path modal as items succeed.
        if (event === "end" && ok === true && this.progressSection) {
          this.sectionProgress?.recordLiveActionSuccess(
            this.progressSection,
            actionType,
            localPath,
          );
        }
        // Terminal outcomes are applied from SyncResult; surface live errors early
        // and append failed lines so chips open a useful log before any success.
        if (event === "end" && ok === false) {
          this.fileSyncStatus.markError(
            localPath,
            error ? `Sync failed: ${error}` : "Sync failed for this file",
          );
          if (
            this.progressSection
            && isLiveProgressActionType(actionType)
          ) {
            this.sectionProgress?.recordLiveActionFailure(
              this.progressSection,
              actionType,
              localPath,
              error,
            );
          }
        }
      },
      onScanProgress: (completed: number, total: number) => {
        // Local list/hash fill while the section is still marked Scanning….
        if (this.progressSection) {
          this.sectionProgress?.updateOperationProgress(this.progressSection, completed, total);
        }
      },
      onActivityPath: (path: string) => {
        // Latest activity paths for the accent count-link peek in the footer.
        if (this.progressSection) {
          this.sectionProgress?.recordActivityPath(this.progressSection, path);
        }
      },
      onProgress: (completed: number, total: number, failed: number) => {
        // Drive the active explorer segment fill from plan execute progress.
        // Do not mirror % / counts into the status bar — that UI is the explorer panel only.
        if (this.progressSection) {
          this.sectionProgress?.updateOperationProgress(this.progressSection, completed, total);
        }
        if (completed % 10 === 0 || completed === total || failed > 0) {
          const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
          void this.log(`execute: ${completed}/${total} (${failed} failed)`, {
            pct,
            completed,
            total,
            failed,
          }, { hypothesisId: SyncHypotheses.sync, location: "main.onProgress" });
        }
      },
    };
  }

  // ── Private: Init ──

  private async initEngine(): Promise<void> {
    this.getOrCreateEngine();
    await this.engineMgr?.restoreDeleteLog();
  }

  /**
   * Engine + vault file-watch hooks require a vault ID. After qa:restart wipe,
   * layoutReady runs before the user sets syncName — call this again on link.
   */
  private async ensureVaultSyncHooks(): Promise<void> {
    if (!this.settings.syncName) return;
    await this.initEngine();
    this.registerVaultEvents();
  }

  private registerVaultEvents(): void {
    if (this.vaultEventsRegistered) return;
    this.vaultEventsRegistered = true;
    const engine = this.getOrCreateEngine();
    const excludes = this.settings.excludePatterns;

    // #region agent log
    void this.log("vault events registered", {
      syncName: this.settings.syncName,
      syncOnCreateDeleteRename: this.settings.syncOnCreateDeleteRename,
      hypothesisId: "H-vault-events",
    }, { location: "main.registerVaultEvents" });
    // #endregion

    // #region agent log
    // H-editor: observe editor-change rate vs vault modify (no behavior change).
    this.registerEvent(
      this.app.workspace.on("editor-change", (_editor, info) => {
        const path =
          info && "file" in info && info.file
            ? info.file.path
            : this.app.workspace.getActiveFile()?.path ?? null;
        this.editorChangeCount += 1;
        this.editorChangesSinceLastVaultModify += 1;
        this.lastEditorChangeAt = Date.now();
        this.lastEditorChangePath = path;
        // Throttle: at most one ingest line / 500ms while typing.
        if (Date.now() - this.lastEditorChangeLogAt < 500) return;
        this.lastEditorChangeLogAt = Date.now();
        this.debounceTrace("editor-change (sample)", {
          path,
          editorChangeCount: this.editorChangeCount,
          editorChangesSinceLastVaultModify: this.editorChangesSinceLastVaultModify,
          msSinceLastEditorChange: 0,
          hypothesisId: "H-editor",
          ...this.debounceSnapshot(),
        });
      }),
    );
    // #endregion

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile)) return;
        if (!vaultEventShouldTriggerSync(file.path, excludes)) return;
        // G18: conflict-copy bursts settle via the existing debounced sync (row 22) —
        // no separate conflict debounce timer is needed here.
        if (!isConflictFile(file.path)) {
          this.fileSyncStatus.markPending(
            file.path,
            "This file has local changes that have not synced to Dropbox yet",
          );
        }
        // #region agent log
        const active = this.app.workspace.getActiveFile();
        const msSinceEditorChange = this.lastEditorChangeAt
          ? Date.now() - this.lastEditorChangeAt
          : null;
        this.debounceTrace("vault modify", {
          path: file.path,
          isActiveFile: active?.path === file.path,
          activePath: active?.path ?? null,
          editorChangesSinceLastVaultModify: this.editorChangesSinceLastVaultModify,
          msSinceEditorChange,
          lastEditorChangePath: this.lastEditorChangePath,
          hypothesisId: "H-autosave-gap",
          ...this.debounceSnapshot(),
        });
        this.editorChangesSinceLastVaultModify = 0;
        // #endregion
        this.noteVaultActivityAndScheduleDebounce("vault:modify");
      }),
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (!(file instanceof TFile)) return;
        if (!vaultEventShouldTriggerSync(file.path, excludes)) return;
        const p = file.path.toLowerCase();
        this.fileSyncStatus.clearPath(file.path);
        if (this.syncDeletedByEngine.delete(p)) {
          void this.log("vault delete ignored (engine-owned)", { path: p }, {
            hypothesisId: SyncHypotheses.sync,
            location: "main.vault.delete",
          });
          return;
        }
        engine.trackDelete(p, file.path);
        this.engineMgr?.persistDeleteLog();
        void this.log("vault delete tracked", {
          path: p,
          syncing: this.syncing,
          pendingDeleteLog: engine.getDeleteLog().length,
        }, { hypothesisId: SyncHypotheses.reInferDeletes, location: "main.vault.delete" });
        this.noteVaultActivityAndScheduleDebounce("vault:delete");
      }),
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFile)) return;
        this.fileSyncStatus.renamePath(oldPath, file.path);
        const triggersSync = vaultRenameShouldTriggerSync(oldPath, file.path, excludes);
        if (triggersSync && !this.suppressRenameDeleteTracking) {
          // C1: case-only renames share path_lower — do not record a delete intent.
          if (oldPath.toLowerCase() !== file.path.toLowerCase()) {
            engine.trackDelete(oldPath.toLowerCase(), oldPath);
          }
          this.engineMgr?.persistDeleteLog();
        }
        if (triggersSync) {
          this.fileSyncStatus.markPending(
            file.path,
            "This file has local changes that have not synced to Dropbox yet",
          );
          this.noteVaultActivityAndScheduleDebounce("vault:rename");
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (!(file instanceof TFile)) return;
        if (!vaultEventShouldTriggerSync(file.path, excludes)) return;
        // keep_both siblings are not sync targets — don't badge them as pending uploads.
        if (!isConflictFile(file.path)) {
          this.fileSyncStatus.markPending(
            file.path,
            "This file has not synced to Dropbox yet",
          );
        }
        if (!this.settings.syncOnCreateDeleteRename) return;
        // #region agent log
        this.debounceTrace("vault create", {
          path: file.path,
          ...this.debounceSnapshot(),
        });
        // #endregion
        this.noteVaultActivityAndScheduleDebounce("vault:create");
      }),
    );
  }

  private async showOnboardingIfNeeded(): Promise<void> {
    if (this.settings.onboardingDone) return;
    this.settings.onboardingDone = true;
    await this.saveSettings();
    if (!getRefreshToken()) {
      new OnboardingModal(this.app, {
        onOpenSettings: () => this.openSettings(),
      }).open();
    }
  }

  // ── Private: Timers ──

  applySyncState(): void {
    if (this.isBackgroundSyncTimerEligible()) {
      if (!this.syncing) {
        this.scheduleBackgroundSyncTimer();
      }
    } else {
      this.clearSyncTimer();
    }
  }

  private isBackgroundSyncTimerEligible(): boolean {
    return (
      this.settings.backgroundSyncEnabled
      && !!getRefreshToken()
      && !!this.settings.syncName
    );
  }

  private scheduleBackgroundSyncTimer(): void {
    if (!this.isBackgroundSyncTimerEligible()) return;
    this.clearSyncTimer();
    const intervalMs = this.settings.syncInterval * 1000;
    // #region agent log
    this.debounceTrace("arm background syncInterval timer", {
      intervalMs,
      syncIntervalSec: this.settings.syncInterval,
    });
    // #endregion
    this.syncTimerId = window.setTimeout(() => {
      this.syncTimerId = null;
      // #region agent log
      this.debounceTrace("background syncInterval FIRE → syncNow", {
        ...this.debounceSnapshot(),
      });
      // #endregion
      void this.syncNow({ trigger: "timer:syncInterval" });
    }, intervalMs);
  }

  private rescheduleBackgroundSyncTimerIfEnabled(): void {
    if (!this.isBackgroundSyncTimerEligible()) return;
    this.scheduleBackgroundSyncTimer();
  }

  /**
   * Local vault activity: stamp quiet-window clock. While a cycle runs, only
   * mark pending — arming a timer mid-sync used to fire shortly after upload
   * finished and re-upload every autosave during continuous typing.
   */
  private noteVaultActivityAndScheduleDebounce(reason: string): void {
    const prevLast = this.lastVaultEventAt;
    this.lastVaultEventAt = Date.now();
    // #region agent log
    this.debounceTrace("noteVaultActivity", {
      reason,
      msSincePrevVaultEvent: prevLast ? this.lastVaultEventAt - prevLast : null,
      ...this.debounceSnapshot(),
    });
    // #endregion
    if (this.syncing) {
      this.pendingDebouncedSync = true;
      // #region agent log
      this.debounceTrace("noteVaultActivity → pending only (syncing)", {
        reason,
        pendingDebouncedSync: true,
      });
      // #endregion
      return;
    }
    this.scheduleDebouncedSync(reason);
  }

  private scheduleDebouncedSync(reason = "unspecified"): void {
    if (!this.settings.backgroundSyncEnabled) {
      // #region agent log
      this.debounceTrace("scheduleDebouncedSync SKIP (background off)", { reason });
      // #endregion
      return;
    }
    const hadTimer = this.debounceTimerId !== null;
    const cancelledArmId = this.activeDebounceArmId;
    this.clearDebounceTimer();
    const debounceMs = this.settings.vaultEventDebounceSec * 1000;
    this.debounceArmId += 1;
    const armId = this.debounceArmId;
    this.activeDebounceArmId = armId;
    // R13: settle local bursts before uploading. This debounce covers vault-event
    // triggers and longpoll echoes — timer resets on each event (G18).
    // #region agent log
    this.debounceTrace("scheduleDebouncedSync ARM", {
      reason,
      armId,
      debounceMs,
      cancelledPreviousTimer: hadTimer,
      cancelledArmId,
      ...this.debounceSnapshot(),
    });
    // #endregion
    void this.log("scheduling debounced sync for settled burst", {
      debounceSec: this.settings.vaultEventDebounceSec,
      syncing: this.syncing,
      msSinceLastVaultEvent: this.lastVaultEventAt
        ? Date.now() - this.lastVaultEventAt
        : null,
      appliesTo: "vault_events_and_longpoll",
      oneConflictCopyPerPath: false,
      reason,
      armId,
    }, {
      category: SyncLogCategories.cycle,
      ruleId: "R13",
      level: "trace",
      location: "main.scheduleDebouncedSync",
    });
    this.debounceTimerId = window.setTimeout(() => {
      this.debounceTimerId = null;
      // #region agent log
      this.debounceTrace("debounce timer FIRE", {
        armId,
        reason,
        stillActiveArm: this.activeDebounceArmId === armId,
        ...this.debounceSnapshot(),
      });
      // #endregion
      if (this.activeDebounceArmId === armId) {
        this.activeDebounceArmId = null;
      }
      this.fireDebouncedSync(reason, armId);
    }, debounceMs);
  }

  /** Start sync only after a full quiet window since lastVaultEventAt. */
  private fireDebouncedSync(reason = "unspecified", armId: number | null = null): void {
    const debounceMs = this.settings.vaultEventDebounceSec * 1000;
    const quietMs = this.lastVaultEventAt
      ? Date.now() - this.lastVaultEventAt
      : debounceMs;
    if (this.syncing) {
      this.pendingDebouncedSync = true;
      // #region agent log
      this.debounceTrace("fireDebouncedSync → pending (syncing)", {
        reason,
        armId,
        quietMs,
        debounceMs,
        ...this.debounceSnapshot(),
      });
      // #endregion
      return;
    }
    if (quietMs < debounceMs) {
      const remainingMs = debounceMs - quietMs;
      // #region agent log
      this.debounceTrace("fireDebouncedSync → re-arm (not quiet)", {
        reason,
        armId,
        quietMs,
        remainingMs,
        debounceMs,
        ...this.debounceSnapshot(),
      });
      // #endregion
      this.clearDebounceTimer();
      this.debounceArmId += 1;
      const reArmId = this.debounceArmId;
      this.activeDebounceArmId = reArmId;
      this.debounceTimerId = window.setTimeout(() => {
        this.debounceTimerId = null;
        // #region agent log
        this.debounceTrace("debounce re-arm timer FIRE", {
          reArmId,
          reason,
          ...this.debounceSnapshot(),
        });
        // #endregion
        if (this.activeDebounceArmId === reArmId) {
          this.activeDebounceArmId = null;
        }
        this.fireDebouncedSync(`${reason}:rearm`, reArmId);
      }, remainingMs);
      return;
    }
    // #region agent log
    this.debounceTrace("fireDebouncedSync → syncNow", {
      reason,
      armId,
      quietMs,
      debounceMs,
      ...this.debounceSnapshot(),
    });
    // #endregion
    void this.syncNow({ trigger: `debounce:${reason}` });
  }

  /** After G19 open-file deferral, wake once when the bound can expire (G10). */
  private scheduleDeferredApplyRetry(): void {
    if (!this.settings.backgroundSyncEnabled) return;
    if (this.deferredApplyTimerId !== null) {
      // #region agent log
      this.debounceTrace("scheduleDeferredApplyRetry SKIP (already armed)", {});
      // #endregion
      return;
    }
    const remainingMs = this.deferralTracker?.minRemainingMs() ?? ACTIVE_FILE_DEFERRAL_MS;
    // Floor at vault debounce so we do not spin tighter than local-edit settle.
    const delayMs = Math.max(remainingMs, this.settings.vaultEventDebounceSec * 1000);
    // #region agent log
    this.debounceTrace("scheduleDeferredApplyRetry ARM", {
      delayMs,
      remainingMs,
      boundMs: ACTIVE_FILE_DEFERRAL_MS,
    });
    // #endregion
    void this.log("scheduling deferred open-file apply retry", {
      delayMs,
      remainingMs,
      boundMs: ACTIVE_FILE_DEFERRAL_MS,
      hypothesisId: "H-defer",
    }, { hypothesisId: SyncHypotheses.cursorStall, location: "main.scheduleDeferredApplyRetry" });
    this.deferredApplyTimerId = window.setTimeout(() => {
      this.deferredApplyTimerId = null;
      // #region agent log
      this.debounceTrace("deferredApplyRetry FIRE → syncNow", {
        ...this.debounceSnapshot(),
      });
      // #endregion
      void this.syncNow({ trigger: "timer:deferredApplyRetry" });
    }, delayMs);
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimerId !== null) {
      // #region agent log
      this.debounceTrace("clearDebounceTimer", {
        clearedArmId: this.activeDebounceArmId,
      });
      // #endregion
      window.clearTimeout(this.debounceTimerId);
      this.debounceTimerId = null;
      this.activeDebounceArmId = null;
    }
  }

  private clearDeferredApplyTimer(): void {
    if (this.deferredApplyTimerId !== null) {
      // #region agent log
      this.debounceTrace("clearDeferredApplyTimer", {});
      // #endregion
      window.clearTimeout(this.deferredApplyTimerId);
      this.deferredApplyTimerId = null;
    }
  }

  /**
   * When the user leaves a deferred note (or reopens another), apply pending
   * open-file downloads without waiting for the G10 bound / syncInterval.
   * Do not use vault-event debounce here — the remote bytes are already known;
   * we only need to run a cycle now that the open-file bind is clear.
   */
  private async flushDeferredAppliesAfterLeafChange(): Promise<void> {
    if (!this.settings.backgroundSyncEnabled || this.syncing) {
      // #region agent log
      this.debounceTrace("leaf flush SKIP", {
        backgroundSyncEnabled: this.settings.backgroundSyncEnabled,
        ...this.debounceSnapshot(),
      });
      // #endregion
      return;
    }
    const store = this.engineMgr?.store;
    if (!store) return;
    const retryEntries = parseRetrySet(await store.getMeta(RETRY_SET_META_KEY));
    if (retryEntries.length === 0) return;
    const unlocked = retryEntries.filter(
      (entry) => !shouldDeferApplyForOpenEditors(this.app, entry.localPath),
    );
    if (unlocked.length === 0) return;
    // #region agent log
    this.debounceTrace("leaf flush → syncNow immediate", {
      unlocked: unlocked.map((e) => e.localPath).slice(0, 5),
      retrySetSize: retryEntries.length,
      hypothesisId: "H-leaf-flush",
      runId: "post-fix",
    });
    // #endregion
    this.clearDeferredApplyTimer();
    void this.syncNow({ trigger: "leaf:flush-deferred" });
  }

  private clearSyncTimer(): void {
    if (this.syncTimerId !== null) {
      // #region agent log
      this.debounceTrace("clearSyncTimer (syncInterval)", {});
      // #endregion
      window.clearTimeout(this.syncTimerId);
      this.syncTimerId = null;
    }
  }

  // #region agent log
  /** Compact timer/vault state for debounce forensics (session H-debounce-trace). */
  private debounceSnapshot(): Record<string, unknown> {
    return {
      syncing: this.syncing,
      pendingDebouncedSync: this.pendingDebouncedSync,
      debounceTimerArmed: this.debounceTimerId !== null,
      activeDebounceArmId: this.activeDebounceArmId,
      deferredApplyArmed: this.deferredApplyTimerId !== null,
      syncIntervalArmed: this.syncTimerId !== null,
      msSinceLastVaultEvent: this.lastVaultEventAt
        ? Date.now() - this.lastVaultEventAt
        : null,
      debounceSec: this.settings.vaultEventDebounceSec,
      syncIntervalSec: this.settings.syncInterval,
      backgroundSyncEnabled: this.settings.backgroundSyncEnabled,
      activeSyncCycleId: this.activeSyncCycleId,
    };
  }

  /**
   * Debounce forensics → vault log file + Cursor Debug ingest (requestUrl via
   * postCursorDebugLogLine). Never use fetch/hardcoded ingest URLs here.
   */
  private debounceTrace(event: string, data: Record<string, unknown>): void {
    void this.log(`[debounce-trace] ${event}`, {
      ...data,
      t: Date.now(),
    }, {
      location: "main.debounceTrace",
      hypothesisId: "H-debounce-trace",
      category: SyncLogCategories.cycle,
      level: "debug",
      temp: "P4",
    });
  }
  // #endregion

  // ── Private: UI ──

  /**
   * Status bar is a view of FileSyncStatusTracker for getActiveFile() only.
   * Empty leaf / idle synced file → hidden; tab switches re-run this.
   */
  private refreshStatusBarForActiveFile(): void {
    void this.refreshStatusBarForActiveFileAsync();
  }

  private async refreshStatusBarForActiveFileAsync(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      this.statusBar?.setActiveFileStatus(null);
      return;
    }
    const path = file.path;
    const existing = this.fileSyncStatus.get(path);
    if (existing) {
      this.statusBar?.setActiveFileStatus(existing);
      return;
    }

    // Never-synced: pending on open without hashing the file (avoids tab-switch cost).
    // Skip .conflict-* siblings — they are keep_both artifacts, not sync targets.
    const store = this.engineMgr?.store;
    if (
      store
      && !isConflictFile(path)
      && vaultEventShouldTriggerSync(path, this.settings.excludePatterns)
    ) {
      try {
        const entry = await store.getEntry(path.toLowerCase());
        if (this.app.workspace.getActiveFile()?.path !== path) return;
        if (!entry) {
          this.fileSyncStatus.markPending(
            path,
            "This file has not synced to Dropbox yet",
          );
          return;
        }
      } catch {
        /* store unavailable — leave icon hidden */
      }
    }

    if (this.app.workspace.getActiveFile()?.path !== path) return;
    this.statusBar?.setActiveFileStatus(null);
  }

  /** Conflict → compare modal; other states keep the vault Sync status modal. */
  private handleStatusBarClick(): void {
    if (this.statusBar?.lastStatus === "conflict") {
      const file = this.app.workspace.getActiveFile();
      if (file) {
        new ConflictCompareModal(this.app, {
          localPath: file.path,
          conflictSiblingPath: this.statusBar.conflictSiblingPath,
        }).open();
        return;
      }
    }
    this.showStatusModal();
  }

  private showStatusModal(): void {
    new SyncStatusModal(
      this.app,
      {
        status: this.statusBar?.lastStatus ?? "hidden",
        detail: this.statusBar?.lastDetail,
        backgroundSyncEnabled: this.settings.backgroundSyncEnabled,
        lastSyncTime: this.lastSyncTime,
        lastSyncSummary: this.lastSyncSummary,
        deviceId: getDeviceId(),
        version: this.manifest.version,
      },
      {
        onSyncNow: () => this.openSyncScopeModal(),
        onToggleBackgroundSync: () => {
          void (this.settings.backgroundSyncEnabled
            ? this.disableBackgroundSync()
            : this.enableBackgroundSync());
        },
        onOpenSettings: () => this.openSettings(),
        onViewLogs: () => { void this.showLogs(); },
        checkRemote: () => this.checkRemoteChanges(),
      },
    ).open();
  }

  private showContextMenu(evt: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item.setTitle("Sync now").setIcon("refresh-cw").onClick(() => this.openSyncScopeModal()),
    );
    menu.addItem((item) =>
      item
        .setTitle(
          this.settings.backgroundSyncEnabled
            ? "Turn off automatic sync"
            : "Turn on automatic sync",
        )
        .setIcon(this.settings.backgroundSyncEnabled ? "pause" : "play")
        .onClick(() => {
          void (this.settings.backgroundSyncEnabled
            ? this.disableBackgroundSync()
            : this.enableBackgroundSync());
        }),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle("Settings").setIcon("settings").onClick(() => this.openSettings()),
    );
    menu.showAtMouseEvent(evt);
  }

  private async showLogs(): Promise<void> {
    const content = await this.readLogs();
    new LogViewerModal(this.app, content, getDeviceId()).open();
  }

  private openSettings(): void {
    this.app.setting?.open();
    this.app.setting?.openTabById(this.manifest.id);
  }

  /**
   * Confirm deferred deletes for one vault section during the trailing Deletions
   * segment. Under-threshold (or protection off) auto-approves; over-threshold
   * opens DeleteConfirmModal with the section label so successive prompts are clear.
   */
  private async confirmDeferredSectionDeletes(
    deleteItems: SyncPlanItem[],
    sectionLabel: string,
  ): Promise<boolean> {
    const guard = checkDeleteGuard(
      {
        items: deleteItems,
        stats: {
          ...emptySyncPlanStats(),
          deleteLocal: deleteItems.filter((i) => i.action.type === "deleteLocal").length,
          deleteRemote: deleteItems.filter((i) => i.action.type === "deleteRemote").length,
        },
      },
      this.settings.deleteThreshold,
      this.settings.deleteProtection,
      createSyncMonitorLog((msg, data, meta) => this.log(msg, data, meta)),
    );
    if (guard.passed) return true;

    if (this.deleteConfirmModal) {
      void this.log("deferred delete guard: modal already open — treating as skip", {
        sectionLabel,
        deleteCount: deleteItems.length,
      }, { hypothesisId: SyncHypotheses.guardSkip, location: "main.confirmDeferredSectionDeletes" });
      return false;
    }

    const modal = new DeleteConfirmModal(this.app, deleteItems, sectionLabel);
    this.deleteConfirmModal = modal;
    try {
      const approved = await modal.waitForConfirmation();
      void this.log(
        approved
          ? `deferred delete guard: approved ${deleteItems.length} (${sectionLabel})`
          : `deferred delete guard: skipped ${deleteItems.length} (${sectionLabel})`,
        { sectionLabel, approved, threshold: this.settings.deleteThreshold },
        { hypothesisId: SyncHypotheses.guardSkip, location: "main.confirmDeferredSectionDeletes" },
      );
      return approved;
    } finally {
      this.deleteConfirmModal = null;
    }
  }

  /**
   * G21: user choice when a file open here was deleted on another device.
   * Returns true to delete locally too; false keeps editing (bounded deferral).
   */
  private async confirmDeleteLocalWhileOpen(path: string): Promise<boolean> {
    if (this.openFileDeleteModal) {
      void this.log("open-file delete guard: modal already open — keep editing", {
        path,
      }, { hypothesisId: SyncHypotheses.guardSkip, location: "main.confirmDeleteLocalWhileOpen" });
      return false;
    }
    const modal = new ConfirmModal(
      this.app,
      "File deleted elsewhere",
      `"${path}" is open here but was deleted on another device.`,
      "Keep editing to retain your local copy, or delete it here too.",
      "Delete here too",
      "Keep editing",
    );
    this.openFileDeleteModal = modal;
    try {
      const deleteHere = await modal.waitForConfirmation();
      void this.log(
        deleteHere
          ? `open-file delete guard: delete here too (${path})`
          : `open-file delete guard: keep editing (${path})`,
        { path },
        { hypothesisId: SyncHypotheses.guardSkip, location: "main.confirmDeleteLocalWhileOpen" },
      );
      return deleteHere;
    } finally {
      this.openFileDeleteModal = null;
    }
  }

  /**
   * Drop orphan delete-log paths (no sync base entry and no local file).
   * Load base keys + local paths once — per-path getEntry + getFiles().some
   * was O(n²) and stalled iPad sync start with thousands of delete intents.
   */
  private async pruneStaleDeleteLog(engine: SyncEngine): Promise<number> {
    const store = this.engineMgr?.store;
    if (!store) return 0;
    const deleteLog = engine.getDeleteLog();
    if (deleteLog.length === 0) return 0;

    const basePathLowers = new Set(
      (await store.getAllEntries()).map((entry) => entry.pathLower),
    );
    const localPathLowers = new Set(
      this.app.vault.getFiles().map((file) => file.path.toLowerCase()),
    );

    let pruned = 0;
    engine.clearOutOfScopeDeleteIntents();
    for (const pathLower of deleteLog) {
      if (!basePathLowers.has(pathLower) && !localPathLowers.has(pathLower)) {
        engine.clearDeleteIntent(pathLower);
        pruned++;
      }
    }
    return pruned;
  }

  private async handlePathIssues(issues: PathGuardIssue[]): Promise<PathIssueResolution> {
    if (this.incompatiblePathsModal) {
      return { action: "skip" };
    }
    const modal = new IncompatiblePathsModal(this.app, issues, {
      strictLocal: Platform.isIosApp || Platform.isMobile,
    });
    this.incompatiblePathsModal = modal;
    try {
      const resolution = await modal.waitForResolution();
      if (resolution.action === "renamed") {
        const deps = this.createEngineDeps();
        const engine = this.getOrCreateEngine();
        this.suppressRenameDeleteTracking = true;
        try {
          await applyPathRenames(deps.fs, deps.remote, deps.store, resolution.renames);
        } finally {
          this.suppressRenameDeleteTracking = false;
        }
        for (const { from } of resolution.renames) {
          engine.clearDeleteIntent(from.toLowerCase());
        }
        this.engineMgr?.persistDeleteLog();
        await this.log("path renames applied", resolution.renames);
      }
      return resolution;
    } finally {
      this.incompatiblePathsModal = null;
    }
  }

  private reportSyncResult(
    result: SyncResult,
    deletesSkipped?: number,
    pathsSkipped?: number,
    permanentSkips?: PermanentSkipEntry[],
  ): { outcome: SyncOutcome; endMessage: string; noticeDuration: number } {
    const feedback = buildSyncResultFeedback(result, deletesSkipped, pathsSkipped, permanentSkips);
    if (result.failed.length > 0) {
      for (const f of result.failed) {
        const err = f.error;
        const detail = err ? { message: err.message, name: err.name, stack: err.stack?.split("\n").slice(0, 3).join(" | ") } : err;
        void this.log(`FAIL ${f.item.action.type} ${f.item.localPath}`, detail);
      }
    }
    // Per-file icons: apply path outcomes (vault-wide status bar updates removed).
    this.fileSyncStatus.applySyncResult(result);

    this.lastSyncSummary = feedback.summary;
    return feedback;
  }

  private async checkRemoteChanges(): Promise<{ pendingChanges: number } | null> {
    const store = this.engineMgr?.store;
    const remote = this.engineMgr?.remote;
    if (!store || !remote) return null;
    const cursor = await store.getMeta("cursor");
    if (!cursor) return null;
    const result = await remote.listChanges(cursor);
    return { pendingChanges: result.entries.length };
  }
}

/** Short labels matching explorer progress segments (Files, not "Notes & files"). */
function deferredDeleteSectionLabel(section: VaultSection): string {
  switch (section) {
    case "notes":
      return "Files";
    case "settings":
      return "Settings";
    case "plugins":
      return "Plugins";
    case "workspaces":
      return "Workspaces";
  }
}
