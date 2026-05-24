import { Menu, Notice, Platform, Plugin, TFile } from "obsidian";
import {
  DEFAULT_SETTINGS,
  generateDeviceId,
  getDefaultExcludePatterns,
  mergeBuiltInExcludePatterns,
  getEffectiveAppKey,
  getEffectiveRemotePath,
  type PluginSettings,
} from "./settings";
import { DropboxSyncSettingTab } from "./ui/settings-tab";
import { StatusBar } from "./ui/status-bar";
import { ConflictModal } from "./ui/conflict-modal";
import { DeleteConfirmModal } from "./ui/delete-confirm-modal";
import { IncompatiblePathsModal } from "./ui/incompatible-paths-modal";
import { LogViewerModal } from "./ui/log-viewer-modal";
import { SyncStatusModal } from "./ui/sync-status-modal";
import { OnboardingModal } from "./ui/onboarding-modal";
import { VaultAdapter } from "./adapters/vault-adapter";
import { DropboxAdapter, DropboxAuthError } from "./adapters/dropbox-adapter";
import { IndexedDBStore } from "./adapters/indexeddb-store";
import { VaultFileStore } from "./adapters/vault-file-store";
import type { ConflictContext, DeleteGuardResult, PathGuardIssue, PathIssueResolution, SyncResult } from "./types";
import { applyPathRenames } from "./sync/path-rename";
import type { RemoteStorage, SyncStateStore } from "./adapters/interfaces";
import { obsidianHttpClient } from "./http-client.plugin";
import { DesktopAuth } from "./auth/desktop-auth";
import { LongpollManager } from "./sync/longpoll";
import { EngineManager } from "./sync/engine-manager";
import { LogManager } from "./log-manager";
import { registerDemoCommands } from "./debug/demo-commands";
import type { SyncEngine } from "./sync/engine";

import { fetchFileFromRemote } from "./deep-link";
import {
  buildSyncLogPath,
  buildSyncResultFeedback,
  buildSyncSummaryMarkdown,
  notifySyncEnd,
  notifySyncStart,
  setRibbonSyncing,
  writeSyncLogFallback,
  type SyncOutcome,
  type SyncReportInput,
} from "./ui/sync-feedback";
import { SyncLiveReport } from "./ui/sync-live-report";
import { SyncScopeModal } from "./ui/sync-scope-modal";
import type { VaultSection } from "./sync/sync-scope";
import type { SyncPlan } from "./types";
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
  private syncing = false;
  private syncTimerId: number | null = null;
  private abortController: AbortController | null = null;
  onAuthChange: (() => void) | null = null;
  private logger: LogManager | null = null;
  private debounceTimerId: number | null = null;
  private lastSyncTime: number | null = null;
  private lastSyncSummary: string | null = null;
  private ribbonEl: HTMLElement | null = null;
  private conflictIndex = 0;
  private conflictTotal = 0;
  private syncDeletedByEngine = new Set<string>();
  private deleteGuardApproved = false;
  private deleteConfirmModal: DeleteConfirmModal | null = null;
  private incompatiblePathsModal: IncompatiblePathsModal | null = null;
  /** applyPathRenames 중 vault rename → trackDelete 억제 */
  private suppressRenameDeleteTracking = false;
  private lastManualSyncSections: VaultSection[] = sectionsFromToggles(
    getManualSyncToggleDefaults(DEFAULT_SETTINGS),
  );
  /** Scope modal open — ribbon stays idle until user picks an option. */
  private scopeModalOpen = false;

  get isSyncing(): boolean {
    return this.syncing;
  }

  // ── 모듈 ──
  private auth: DesktopAuth | null = null;
  private longpoll: LongpollManager | null = null;
  private engineMgr: EngineManager | null = null;

  private log(msg: string, data?: unknown): Promise<void> {
    if (!this.logger) {
      console.debug("[Dropbox Sync]", msg, data ?? "");
      return Promise.resolve();
    }
    return this.logger.log(msg, data);
  }

  // ── Lifecycle ──

  async onload(): Promise<void> {
    await this.loadSettings();

    let needsSave = false;
    if (!this.settings.deviceId) {
      this.settings.deviceId = generateDeviceId();
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
    if (needsSave) {
      await this.saveSettings();
    }

    this.logger = new LogManager(
      this.app.vault.adapter,
      () => `sync-debug-${this.settings.deviceId || "unknown"}.log`,
    );

    this.addSettingTab(new DropboxSyncSettingTab(this.app, this));
    this.statusBar = new StatusBar(this.addStatusBarItem());

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
    this.statusBar?.onClick(() => this.showStatusModal());
    this.statusBar?.onContextMenu((evt) => this.showContextMenu(evt));

    this.app.workspace.onLayoutReady(async () => {
      if (this.settings.syncName) {
        await this.initEngine();
        this.registerVaultEvents();
      }
      this.applySyncState();
      void this.showOnboardingIfNeeded();
    });
  }

  onunload(): void {
    this.clearSyncTimer();
    this.clearDebounceTimer();
    this.longpoll?.stop();
    this.statusBar?.destroy();
  }

  // ── Settings ──

  async loadSettings(): Promise<void> {
    const raw = await this.loadData() as (Partial<PluginSettings> & { syncEnabled?: boolean }) | null;
    const migrated = migrateSettings(raw);
    this.settings = Object.assign({}, DEFAULT_SETTINGS, migrated);
    if (raw?.syncEnabled !== undefined && raw.backgroundSyncEnabled === undefined) {
      this.settings.backgroundSyncEnabled = raw.syncEnabled;
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.engineMgr?.reset();
    this.applySyncState();
  }

  resetEngine(): void {
    this.engineMgr?.reset();
  }

  // ── Auth ──

  async startAuth(): Promise<void> {
    await this.auth?.start();
  }

  private async handleAuthCallback(params: Record<string, string>): Promise<void> {
    if (!this.auth) return;
    const tokens = await this.auth.handleCallback(params);
    if (!tokens) return;

    this.settings.accessToken = tokens.accessToken;
    this.settings.refreshToken = tokens.refreshToken;
    this.settings.tokenExpiry = tokens.expiresAt;
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

    if (!this.settings.refreshToken) {
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
      this.cancelCurrentSync();
      return;
    }
    if (this.scopeModalOpen) return;
    await this.openSyncScopeModal();
  }

  async openSyncScopeModal(): Promise<void> {
    if (!this.settings.refreshToken) {
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

  cancelCurrentSync(): void {
    if (!this.syncing) return;
    this.abortController?.abort();
    this.syncing = false;
    this.abortController = null;
    setRibbonSyncing(this.ribbonEl, false);
    this.statusBar?.update("idle", "stopping…");
    new Notice("Dropbox Sync: stopping…", 2000);
  }

  async syncNow(options?: { manual?: boolean; sections?: VaultSection[] }): Promise<void> {
    const manual = options?.manual ?? false;
    let scopeLabel: string;
    let manualSections: VaultSection[] | undefined;
    if (manual) {
      const sections = options?.sections ?? this.lastManualSyncSections;
      if (sections.length === 0) {
        new Notice("Dropbox sync: at least one section must be enabled.");
        return;
      }
      this.lastManualSyncSections = sections;
      manualSections = sections;
      scopeLabel = formatBackgroundSectionsLabel(sections);
    } else {
      const sections = getEnabledBackgroundSections(this.settings);
      scopeLabel = formatBackgroundSectionsLabel(sections);
    }
    if (this.syncing) return;
    if (!this.settings.syncName) {
      new Notice("Dropbox sync: set a vault ID in settings first.");
      return;
    }
    if (!this.settings.refreshToken) {
      new Notice("Dropbox sync: not connected. Open settings to connect.");
      return;
    }
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      await this.log("sync skipped: offline");
      return;
    }

    const startedAt = Date.now();
    this.syncing = true;
    this.clearSyncTimer();
    this.abortController = new AbortController();
    this.longpoll?.stop();
    if (!this.scopeModalOpen) {
      setRibbonSyncing(this.ribbonEl, true);
    }
    this.statusBar?.update("syncing");

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
    let liveReport: SyncLiveReport | null = null;

    if (manual) {
      try {
        liveReport = await SyncLiveReport.open(this.app, {
          startedAt,
          deviceId: this.settings.deviceId,
          version: this.manifest.version,
          scope: scopeLabel,
        });
      } catch (e) {
        console.error("[Dropbox Sync] sync log open failed", e);
        void this.log("live sync report open failed", e);
      }
    }

    if (manual) notifySyncStart();
    void this.log(`sync started (v${this.manifest.version}, scope: ${scopeLabel})`);

    try {
      const engine = this.getOrCreateEngine();
      engine.setLiveReport(liveReport);
      const configDir = this.app.vault.configDir;
      if (manual && manualSections) {
        engine.setSyncSections(manualSections, configDir);
      } else {
        engine.setSyncSections(getEnabledBackgroundSections(this.settings), configDir);
      }
      const prunedDeletes = await this.pruneStaleDeleteLog(engine);
      if (prunedDeletes > 0) {
        liveReport?.line(`pruned ${prunedDeletes} stale delete-log entry/entries`);
        this.engineMgr?.persistDeleteLog();
      }
      this.conflictIndex = 0;
      this.conflictTotal = 0;
      const cycleResult = await engine.runCycle(this.abortController.signal);
      plan = cycleResult.plan;
      result = cycleResult.result;
      deletesSkipped = cycleResult.deletesSkipped;
      deferredCount = cycleResult.deferredCount;
      pathsSkipped = cycleResult.pathsSkipped;

      await this.log(`plan: ${plan.items.length} items, succeeded: ${result.succeeded.length}, failed: ${result.failed.length}, deletesSkipped: ${deletesSkipped ?? 0}, deferred: ${deferredCount ?? 0}, pathsSkipped: ${pathsSkipped ?? 0}`);

      if (cycleResult.pathRenamesApplied) {
        needsResyncAfterRename = true;
        outcome = "renamed_resync";
        endMessage = "Dropbox Sync: files renamed. Syncing again…";
        noticeDuration = 5000;
        this.lastSyncSummary = "renamed — resyncing";
        this.statusBar?.update("success", "renamed — resyncing");
        return;
      }

      this.engineMgr?.persistDeleteLog();

      const feedback = this.reportSyncResult(result, deletesSkipped, pathsSkipped);
      outcome = feedback.outcome;
      endMessage = feedback.endMessage;
      noticeDuration = feedback.noticeDuration;

      if (result.failed.length === 0 && !deletesSkipped && !deferredCount) {
        cursorUpdated = true;
      }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        await this.log("sync aborted");
        outcome = "aborted";
        endMessage = "Dropbox Sync: cancelled";
        noticeDuration = 3000;
        this.statusBar?.update("idle");
        return;
      }
      if (e instanceof DropboxAuthError) {
        await this.log("auth error — token revoked", e);
        this.settings.accessToken = "";
        this.settings.tokenExpiry = 0;
        await this.saveSettings();
        outcome = "auth_error";
        errorMessage = "Token expired";
        endMessage = "Dropbox sync: token expired. Please reconnect in settings.";
        noticeDuration = 8000;
        this.lastSyncSummary = "auth expired";
        this.statusBar?.update("error", "auth expired");
        return;
      }
      await this.log("sync error", e);
      outcome = "error";
      errorMessage = (e as Error).message;
      endMessage = `Dropbox Sync error: ${errorMessage}`;
      noticeDuration = 8000;
      this.lastSyncSummary = "sync failed";
      this.statusBar?.update("error", "sync failed");
    } finally {
      const endedAt = Date.now();
      setRibbonSyncing(this.ribbonEl, false);
      if (manual) notifySyncEnd(endMessage, noticeDuration);

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
        deviceId: this.settings.deviceId,
        version: this.manifest.version,
      };

      const engine = this.getOrCreateEngine();
      engine.setLiveReport(null);
      if (liveReport) {
        await liveReport.finalize(reportInput);
      } else if (manual) {
        const markdown = buildSyncSummaryMarkdown(reportInput);
        await writeSyncLogFallback(this.app, buildSyncLogPath(startedAt), markdown);
      }

      this.syncing = false;
      this.syncDeletedByEngine.clear();
      this.abortController = null;
      this.lastSyncTime = endedAt;
      await this.logger?.flush();
      // 미소비 삭제가 있으면 후속 싱크 스케줄 (싱크 중 사용자 삭제 처리)
      if (this.engineMgr?.hasPendingDeletes() && this.settings.backgroundSyncEnabled) {
        this.scheduleDebouncedSync();
      } else if (cursorUpdated && this.settings.backgroundSyncEnabled) {
        this.longpoll?.schedule();
      } else if (needsResyncAfterRename) {
        window.setTimeout(
          () => void this.syncNow({ manual: true, sections: this.lastManualSyncSections }),
          200,
        );
      }
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
    if (!appKey || !this.settings.accessToken) return null;

    try {
      const resp = await obsidianHttpClient({
        url: "https://api.dropboxapi.com/2/files/list_folder",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.settings.accessToken}`,
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
        onChanges: () => { void this.syncNow(); },
        log: (msg, data) => this.log(msg, data),
      });
    }
    return this.engineMgr;
  }

  private createEngineDeps() {
    const vaultId = this.app.vault.getName();
    const fs = new VaultAdapter(this.app.vault, this.settings.excludePatterns, this.app.fileManager);
    const remote = new DropboxAdapter({
      httpClient: obsidianHttpClient,
      appKey: getEffectiveAppKey(this.settings),
      remotePath: getEffectiveRemotePath(this.settings),
      getAccessToken: () => this.settings.accessToken,
      getRefreshToken: () => this.settings.refreshToken,
      getTokenExpiry: () => this.settings.tokenExpiry,
      onTokenRefreshed: (accessToken, expiresAt) => {
        this.settings.accessToken = accessToken;
        this.settings.tokenExpiry = expiresAt;
        void this.saveSettings();
      },
    });
    const store: SyncStateStore = Platform.isIosApp
      ? new VaultFileStore(this.app.vault)
      : new IndexedDBStore(vaultId);

    return { fs, remote, store };
  }

  private createEngineOptions() {
    return {
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
      onDeleteGuardTriggered: (guard: DeleteGuardResult): Promise<boolean> => {
        // Previously approved deletions — execute without modal
        if (this.deleteGuardApproved) {
          this.deleteGuardApproved = false;
          return Promise.resolve(true);
        }
        // Already showing a delete confirm modal — skip duplicate
        if (this.deleteConfirmModal) {
          return Promise.resolve(false);
        }
        // Non-blocking: skip deletions now, show modal async.
        // If user approves, flag it and schedule follow-up sync.
        const modal = new DeleteConfirmModal(this.app, guard.deleteItems);
        this.deleteConfirmModal = modal;
        void modal.waitForConfirmation().then((approved) => {
          this.deleteConfirmModal = null;
          if (approved) {
            this.deleteGuardApproved = true;
            this.scheduleDebouncedSync();
          }
        });
        return Promise.resolve(false);
      },
      isFileActive: (path: string) => this.app.workspace.getActiveFile()?.path === path,
      excludePatterns: this.settings.excludePatterns,
      concurrency: 3,
      onConflictCount: (count: number) => {
        this.conflictTotal = count;
        this.conflictIndex = 0;
      },
      onBeforeDeleteLocal: (pathLower: string) => {
        this.syncDeletedByEngine.add(pathLower);
      },
      strictLocalPaths: Platform.isIosApp || Platform.isMobile,
      onPathIssues: (issues: PathGuardIssue[]) => this.handlePathIssues(issues),
      onProgress: (completed: number, total: number, failed: number) => {
        const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
        const failHint = failed > 0 ? ` · ${failed} failed` : "";
        this.statusBar?.update("syncing", `${pct}% · ${completed}/${total}${failHint}`);
        if (completed % 25 === 0 || completed === total) {
          void this.log(`execute: ${completed}/${total} (${failed} failed)`);
        }
      },
    };
  }

  // ── Private: Init ──

  private async initEngine(): Promise<void> {
    this.getOrCreateEngine();
    await this.engineMgr?.restoreDeleteLog();
  }

  private registerVaultEvents(): void {
    const engine = this.getOrCreateEngine();

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (this.syncing || !(file instanceof TFile)) return;
        this.scheduleDebouncedSync();
      }),
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (!(file instanceof TFile)) return;
        const p = file.path.toLowerCase();
        if (this.syncDeletedByEngine.delete(p)) return; // 싱크 엔진이 지운 거면 무시
        engine.trackDelete(p);
        this.engineMgr?.persistDeleteLog();
        if (!this.syncing) this.scheduleDebouncedSync();
      }),
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFile)) return;
        if (!this.suppressRenameDeleteTracking) {
          engine.trackDelete(oldPath.toLowerCase());
          this.engineMgr?.persistDeleteLog();
        }
        if (!this.syncing) this.scheduleDebouncedSync();
      }),
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (this.syncing || !(file instanceof TFile)) return;
        if (this.settings.syncOnCreateDeleteRename) this.scheduleDebouncedSync();
      }),
    );
  }

  private async showOnboardingIfNeeded(): Promise<void> {
    if (this.settings.onboardingDone) return;
    this.settings.onboardingDone = true;
    await this.saveSettings();
    if (!this.settings.refreshToken) {
      new OnboardingModal(this.app, {
        onOpenSettings: () => this.openSettings(),
      }).open();
    }
  }

  // ── Private: Timers ──

  applySyncState(): void {
    if (this.statusBar) {
      this.statusBar.backgroundSyncEnabled = this.settings.backgroundSyncEnabled;
    }

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
      && !!this.settings.refreshToken
      && !!this.settings.syncName
    );
  }

  private scheduleBackgroundSyncTimer(): void {
    if (!this.isBackgroundSyncTimerEligible()) return;
    this.clearSyncTimer();
    this.syncTimerId = window.setTimeout(() => {
      this.syncTimerId = null;
      void this.syncNow();
    }, this.settings.syncInterval * 1000);
  }

  private rescheduleBackgroundSyncTimerIfEnabled(): void {
    if (!this.isBackgroundSyncTimerEligible()) return;
    this.scheduleBackgroundSyncTimer();
  }

  private scheduleDebouncedSync(): void {
    if (!this.settings.backgroundSyncEnabled) return;
    this.clearDebounceTimer();
    this.debounceTimerId = window.setTimeout(() => {
      this.debounceTimerId = null;
      void this.syncNow();
    }, this.settings.vaultEventDebounceSec * 1000);
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimerId !== null) {
      window.clearTimeout(this.debounceTimerId);
      this.debounceTimerId = null;
    }
  }

  private clearSyncTimer(): void {
    if (this.syncTimerId !== null) {
      window.clearTimeout(this.syncTimerId);
      this.syncTimerId = null;
    }
  }

  // ── Private: UI ──

  private showStatusModal(): void {
    new SyncStatusModal(
      this.app,
      {
        status: this.statusBar?.lastStatus ?? "idle",
        detail: this.statusBar?.lastDetail,
        backgroundSyncEnabled: this.settings.backgroundSyncEnabled,
        lastSyncTime: this.lastSyncTime,
        lastSyncSummary: this.lastSyncSummary,
        deviceId: this.settings.deviceId,
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
    new LogViewerModal(this.app, content, this.settings.deviceId).open();
  }

  private openSettings(): void {
    this.app.setting?.open();
    this.app.setting?.openTabById(this.manifest.id);
  }

  /** deleteLog에만 남은 고아 경로 제거 (rename 후 무한 재싱크 방지) */
  private async pruneStaleDeleteLog(engine: SyncEngine): Promise<number> {
    const store = this.engineMgr?.store;
    if (!store) return 0;
    let pruned = 0;
    for (const pathLower of engine.getDeleteLog()) {
      const entry = await store.getEntry(pathLower);
      const hasLocal = this.app.vault.getFiles().some((f) => f.path.toLowerCase() === pathLower);
      if (!entry && !hasLocal) {
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
  ): { outcome: SyncOutcome; endMessage: string; noticeDuration: number } {
    if (result.failed.length > 0) {
      for (const f of result.failed) {
        const err = f.error;
        const detail = err ? { message: err.message, name: err.name, stack: err.stack?.split("\n").slice(0, 3).join(" | ") } : err;
        void this.log(`FAIL ${f.item.action.type} ${f.item.localPath}`, detail);
      }
      this.statusBar?.update("error", `${result.failed.length} failed`);
    } else {
      const feedback = buildSyncResultFeedback(result, deletesSkipped, pathsSkipped);
      if (pathsSkipped && pathsSkipped > 0) {
        this.statusBar?.update("success", feedback.summary);
      } else if (deletesSkipped && deletesSkipped > 0) {
        this.statusBar?.update("success", feedback.summary);
      } else if (result.succeeded.length > 0) {
        this.statusBar?.update("success", feedback.summary);
      } else {
        this.statusBar?.update("success", "up to date");
      }
    }

    const feedback = buildSyncResultFeedback(result, deletesSkipped, pathsSkipped);
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
