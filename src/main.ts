import { Menu, Notice, Platform, Plugin, TFile } from "obsidian";
import {
  DEFAULT_SETTINGS,
  generateDeviceId,
  getDefaultExcludePatterns,
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
import { PathValidationError, LocalPathError } from "./types";
import { applyPathRenames } from "./sync/path-rename";
import type { RemoteStorage, SyncStateStore } from "./adapters/interfaces";
import { obsidianHttpClient } from "./http-client.plugin";
import { DesktopAuth } from "./auth/desktop-auth";
import { LongpollManager } from "./sync/longpoll";
import { EngineManager } from "./sync/engine-manager";
import { LogManager } from "./log-manager";
import { registerDemoCommands } from "./debug/demo-commands";
import type { SyncEngine } from "./sync/engine";

import { summarizeActions } from "./sync/sync-reporter";
import { fetchFileFromRemote } from "./deep-link";

const DEBOUNCE_DELAY_MS = 5000;

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
    if (this.settings.excludePatterns.length === 0) {
      this.settings.excludePatterns = getDefaultExcludePatterns(this.app.vault.configDir);
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
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.syncNow() });
    this.addCommand({ id: "view-logs", name: "View sync logs", callback: () => this.showLogs() });
    this.addCommand({
      id: "toggle-sync",
      name: "Toggle sync on/off",
      callback: () => this.settings.syncEnabled ? this.stopSync() : this.startSync(),
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

    // UI: 리본 + 상태 바
    this.ribbonEl = this.addRibbonIcon("refresh-cw", "Dropbox sync", () => this.syncNow());
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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<PluginSettings>);
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

  async syncNow(): Promise<void> {
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

    this.syncing = true;
    this.abortController = new AbortController();
    this.longpoll?.stop();
    this.statusBar?.update("syncing");
    await this.log(`sync started (v${this.manifest.version})`);

    let cursorUpdated = false;
    let needsResyncAfterRename = false;

    try {
      const engine = this.getOrCreateEngine();
      this.conflictIndex = 0;
      this.conflictTotal = 0;
      const {
        plan,
        result,
        deletesSkipped,
        deferredCount,
        pathRenamesApplied,
        pathsSkipped,
      } = await engine.runCycle(this.abortController.signal);

      await this.log(`plan: ${plan.items.length} items, succeeded: ${result.succeeded.length}, failed: ${result.failed.length}, deletesSkipped: ${deletesSkipped ?? 0}, deferred: ${deferredCount ?? 0}, pathsSkipped: ${pathsSkipped ?? 0}`);

      if (pathRenamesApplied) {
        needsResyncAfterRename = true;
        new Notice("Dropbox Sync: files renamed. Syncing again…");
        this.statusBar?.update("success", "renamed — resyncing");
        return;
      }

      this.engineMgr?.persistDeleteLog();

      this.reportSyncResult(result, deletesSkipped, pathsSkipped);

      if (result.failed.length === 0 && !deletesSkipped && !deferredCount) {
        cursorUpdated = true;
      }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        await this.log("sync aborted");
        this.statusBar?.update("idle");
        return;
      }
      if (e instanceof DropboxAuthError) {
        await this.log("auth error — token revoked", e);
        this.settings.accessToken = "";
        this.settings.tokenExpiry = 0;
        await this.saveSettings();
        this.statusBar?.update("error", "auth expired");
        new Notice("Dropbox sync: token expired. Please reconnect in settings.");
        return;
      }
      await this.log("sync error", e);
      this.statusBar?.update("error", "sync failed");
      new Notice(`Dropbox Sync error: ${(e as Error).message}`);
    } finally {
      this.syncing = false;
      this.syncDeletedByEngine.clear();
      this.abortController = null;
      this.lastSyncTime = Date.now();
      await this.logger?.flush();
      // 미소비 삭제가 있으면 후속 싱크 스케줄 (싱크 중 사용자 삭제 처리)
      if (this.engineMgr?.hasPendingDeletes() && this.settings.syncEnabled) {
        this.scheduleDebouncedSync();
      } else if (cursorUpdated && this.settings.syncEnabled) {
        this.longpoll?.schedule();
      } else if (needsResyncAfterRename && this.settings.syncEnabled) {
        window.setTimeout(() => void this.syncNow(), 200);
      }
    }
  }

  async startSync(): Promise<void> {
    this.settings.syncEnabled = true;
    await this.saveSettings();
    void this.syncNow();
  }

  async stopSync(): Promise<void> {
    this.abortController?.abort();
    this.longpoll?.stop();
    this.settings.syncEnabled = false;
    await this.saveSettings();
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
        isEnabled: () => this.settings.syncEnabled && !!this.engineMgr?.store,
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
      onProgress: (completed: number, total: number) => {
        const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
        this.statusBar?.update("syncing", `${pct}% · ${completed}/${total}`);
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
        engine.trackDelete(oldPath.toLowerCase());
        this.engineMgr?.persistDeleteLog();
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
      this.statusBar.enabled = this.settings.syncEnabled;
    }

    const shouldRun = this.settings.syncEnabled && !!this.settings.refreshToken && !!this.settings.syncName;
    if (shouldRun) {
      this.clearSyncTimer();
      this.syncTimerId = window.setInterval(() => { void this.syncNow(); }, this.settings.syncInterval * 1000);
      this.registerInterval(this.syncTimerId);
    } else {
      this.clearSyncTimer();
    }
  }

  private scheduleDebouncedSync(): void {
    if (!this.settings.syncEnabled) return;
    this.clearDebounceTimer();
    this.debounceTimerId = window.setTimeout(() => {
      this.debounceTimerId = null;
      void this.syncNow();
    }, DEBOUNCE_DELAY_MS);
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimerId !== null) {
      window.clearTimeout(this.debounceTimerId);
      this.debounceTimerId = null;
    }
  }

  private clearSyncTimer(): void {
    if (this.syncTimerId !== null) {
      window.clearInterval(this.syncTimerId);
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
        syncEnabled: this.settings.syncEnabled,
        lastSyncTime: this.lastSyncTime,
        lastSyncSummary: this.lastSyncSummary,
        deviceId: this.settings.deviceId,
        version: this.manifest.version,
      },
      {
        onSyncNow: () => { void this.syncNow(); },
        onToggleSync: () => { void (this.settings.syncEnabled ? this.stopSync() : this.startSync()); },
        onOpenSettings: () => this.openSettings(),
        onViewLogs: () => { void this.showLogs(); },
        checkRemote: () => this.checkRemoteChanges(),
      },
    ).open();
  }

  private showContextMenu(evt: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item.setTitle("Sync now").setIcon("refresh-cw").onClick(() => this.syncNow()),
    );
    menu.addItem((item) =>
      item
        .setTitle(this.settings.syncEnabled ? "Stop Sync" : "Start Sync")
        .setIcon(this.settings.syncEnabled ? "pause" : "play")
        .onClick(() => this.settings.syncEnabled ? this.stopSync() : this.startSync()),
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
        await applyPathRenames(deps.fs, deps.remote, deps.store, resolution.renames);
        await this.log("path renames applied", resolution.renames);
      }
      return resolution;
    } finally {
      this.incompatiblePathsModal = null;
    }
  }

  private reportSyncResult(result: SyncResult, deletesSkipped?: number, pathsSkipped?: number): void {
    if (result.failed.length > 0) {
      for (const f of result.failed) {
        const err = f.error;
        const detail = err ? { message: err.message, name: err.name, stack: err.stack?.split("\n").slice(0, 3).join(" | ") } : err;
        void this.log(`FAIL ${f.item.action.type} ${f.item.localPath}`, detail);
      }
      this.lastSyncSummary = `${result.failed.length} failed, ${result.succeeded.length} ok`;
      this.statusBar?.update("error", `${result.failed.length} failed`);
      const first = result.failed[0];
      const detail = first.error?.message?.slice(0, 100) ?? "";
      const pathHint =
        first.error instanceof PathValidationError || first.error instanceof LocalPathError
          ? "\nFix names via the incompatible-files prompt on next sync."
          : "";
      new Notice(
        `Dropbox Sync: ${result.failed.length} failed (${result.succeeded.length} ok)\n${first.item.localPath}: ${detail}${pathHint}`,
        8000,
      );
    } else if (pathsSkipped && pathsSkipped > 0) {
      const summary = summarizeActions(result.succeeded);
      this.lastSyncSummary = `${summary}, ${pathsSkipped} paths skipped`;
      this.statusBar?.update("success", `${summary}, ${pathsSkipped} paths skipped`);
      new Notice(
        `Dropbox Sync: ${pathsSkipped} file(s) skipped (incompatible names). Other changes synced.`,
        6000,
      );
    } else if (deletesSkipped && deletesSkipped > 0) {
      const summary = summarizeActions(result.succeeded);
      this.lastSyncSummary = `${summary}, ${deletesSkipped} deletes skipped`;
      this.statusBar?.update("success", `${summary}, ${deletesSkipped} deletes skipped`);
      new Notice(`Dropbox Sync: ${summary}, ${deletesSkipped} deletions skipped by protection.`);
    } else if (result.succeeded.length > 0) {
      const summary = summarizeActions(result.succeeded);
      this.lastSyncSummary = summary;
      this.statusBar?.update("success", summary);
      new Notice(`Dropbox Sync: ${summary}`);
    } else {
      this.lastSyncSummary = "up to date";
      this.statusBar?.update("success", "up to date");
    }
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
