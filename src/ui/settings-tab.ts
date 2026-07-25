import { App, Platform, PluginSettingTab, Setting, Notice, TFile } from "obsidian";
import type { ConflictStrategy } from "../types";
import type DropboxSyncPlugin from "../main";
import { ConfirmModal } from "./confirm-modal";
import {
  countEnabledBackgroundSections,
  debounceSecToSliderIndex,
  DEFAULT_APP_KEY,
  getEffectiveAppKey,
  isValidSyncName,
  VAULT_EVENT_DEBOUNCE_OPTIONS,
} from "../settings";
import { SYNC_SCOPE_LABELS, type VaultSection } from "../sync/sync-scope";
import { obsidianHttpClient } from "../http-client.plugin";
import {
  generateCodeVerifier,
  generateCodeChallenge,
  buildAuthUrl,
  exchangeCodeForToken,
} from "../adapters/dropbox-auth";
import { LogViewerModal } from "./log-viewer-modal";
import { isExcluded } from "../exclude";
import {
  patchDeviceSettings,
  readDeviceSettings,
} from "../device-settings/device-settings";
import { DEFAULT_CURSOR_DEBUG_PORT } from "../device-settings/device-settings-defaults";
import { isCursorDebugIngestConfigured } from "../debug/cursor-debug-ingest";
import {
  clearIngestConnection,
  connect as connectCursorDebugIngest,
  connectedButtonLabel,
  hasCachedIngestConnection,
  tryAutoConnect,
} from "../debug/cursor-debug-discover";

const DOCS_BASE = "https://github.com/zeakd/obsidian-dropbox-sync/blob/main/docs";

export class DropboxSyncSettingTab extends PluginSettingTab {
  private codeVerifier: string | null = null;

  constructor(
    app: App,
    private plugin: DropboxSyncPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    this.plugin.onAuthChange = () => this.display();

    const { containerEl } = this;
    containerEl.empty();

    const isConnected = !!this.plugin.settings.refreshToken;
    const hasSyncName = !!this.plugin.settings.syncName;
    const autoSyncOn = this.plugin.settings.backgroundSyncEnabled;

    // ── Status bar ──
    const version = `v${this.plugin.manifest.version}`;
    const status = new Setting(containerEl);
    status.settingEl.addClass("dbx-sync-settings-status-bar");
    if (autoSyncOn) {
      status
        .setName(`Automatic sync on · ${version}`)
        .setDesc("Background sync is active. Use Sync now anytime for a manual run.")
        .addButton((btn) =>
          btn.setButtonText("Sync now").onClick(() => this.plugin.openSyncScopeModal()),
        );
    } else if (isConnected && hasSyncName) {
      status
        .setName(`Manual sync only · ${version}`)
        .setDesc("Automatic sync is off. Use Sync now or enable background sync below.")
        .addButton((btn) =>
          btn.setButtonText("Sync now").onClick(() => this.plugin.openSyncScopeModal()),
        );
    } else if (isConnected) {
      status
        .setName(`Not syncing · ${version}`)
        .setDesc("Set a vault ID to get started.");
    } else {
      status
        .setName(`Not connected · ${version}`)
        .setDesc("Connect to Dropbox to set up sync.");
    }

    // ── Sync ──
    new Setting(containerEl).setName("Sync").setHeading();
    if (!isConnected) {
      new Setting(containerEl)
        .setDesc("Connect to Dropbox to set up sync.");
    } else {
      this.renderSyncSection(containerEl, hasSyncName);
      if (hasSyncName) {
        // Background vs manual vs shared are separate so each toggle's scope is obvious.
        this.renderBackgroundSyncSection(containerEl, autoSyncOn);
        this.renderManualSyncSection(containerEl);
        this.renderSharedSyncOptions(containerEl);
        this.renderAdvancedSafety(containerEl);
        this.renderSyncNameChange(containerEl, this.plugin.settings.syncName);
      }
    }

    // ── Connection ──
    new Setting(containerEl).setName("Connection").setHeading();
    if (isConnected) {
      this.renderDisconnect(containerEl);
    } else {
      this.renderAuth(containerEl);
    }
    this.renderAppKey(containerEl);

    // ── Troubleshooting ──
    const troubleshootingFrag = document.createDocumentFragment();
    const tsLink = troubleshootingFrag.createEl("a", { text: "Troubleshooting guide", href: `${DOCS_BASE}/troubleshooting.md` });
    tsLink.setAttr("target", "_blank");
    new Setting(containerEl).setName("Troubleshooting").setDesc(troubleshootingFrag).setHeading();

    // Wipe sync base/cursor/delete log only — never debugLoggingEnabled, Cursor
    // Debug ingest fields, OAuth, logs, or vault/Dropbox files.
    const clearHistoryDesc = document.createDocumentFragment();
    clearHistoryDesc.appendText(
      "Forget this device’s sync base, Dropbox cursor, and delete log. The next sync behaves like a first install for planning (typically re-downloads). Keeps Debug logging, Cursor Debug ingest settings, your Dropbox login, and all vault files. See ",
    );
    const clearHistoryLink = clearHistoryDesc.createEl("a", {
      text: "Plugin persistence",
      href: `${DOCS_BASE}/plugin-persistence.md`,
    });
    clearHistoryLink.setAttr("target", "_blank");
    clearHistoryDesc.appendText(".");

    new Setting(containerEl)
      .setName("Clear sync history")
      .setDesc(clearHistoryDesc)
      .addButton((btn) =>
        btn
          .setButtonText("Clear history")
          .setWarning()
          .onClick(async () => {
            const modal = new ConfirmModal(
              this.app,
              "Clear sync history?",
              "This device will forget what it has already synced. The next sync will treat the vault as new on this device for planning — usually re-downloading from Dropbox instead of pushing local deletes.",
              "Does not change Debug logging or Cursor Debug ingest settings, does not disconnect Dropbox, and does not delete vault or Dropbox files.",
              "Clear history",
              "Cancel",
              true,
            );
            if (!(await modal.waitForConfirmation())) return;
            await this.plugin.clearSyncHistory();
          }),
      );

    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc(
        "When off, sync debug logs are not written and nothing is sent to Cursor. When on, logs go to the vault file and (if configured below) over Wi‑Fi to Cursor Debug ingest.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.debugLoggingEnabled).onChange(async (value) => {
          this.plugin.settings.debugLoggingEnabled = value;
          // Turning debug off ends the ingest “session” on this device — clear
          // cached host/path so we do not POST to a dead relay after restart.
          if (!value) {
            clearIngestConnection();
          }
          await this.plugin.saveSettings();
          if (value) {
            await tryAutoConnect();
          }
          this.display();
        }),
      );

    if (this.plugin.settings.debugLoggingEnabled) {
      this.renderCursorDebugIngestSettings(containerEl);
      // Silent refresh when Troubleshooting opens — onload / toggle-on notify instead
      // so opening settings does not re-toast every time.
      const before = readDeviceSettings();
      void tryAutoConnect({ notify: false }).then((result) => {
        if (!result.ok) return;
        const after = readDeviceSettings();
        if (
          before.cursorDebugSessionId !== after.cursorDebugSessionId
          || before.cursorDebugIngestPath !== after.cursorDebugIngestPath
          || before.cursorDebugHost !== after.cursorDebugHost
          || before.cursorDebugServerName !== after.cursorDebugServerName
          || !hasCachedIngestConnection()
        ) {
          this.display();
        }
      });
    }

    new Setting(containerEl)
      .setName("View sync logs")
      .setDesc(`Device: ${this.plugin.settings.deviceId || "unknown"}`)
      .addButton((btn) =>
        btn.setButtonText("View logs").onClick(async () => {
          const content = await this.plugin.readLogs();
          new LogViewerModal(this.app, content, this.plugin.settings.deviceId).open();
        }),
      );
  }

  /**
   * Device-local Cursor Debug target. Prefer Connect / auto-connect over paste.
   * Host/session must not live in synced data.json.
   */
  private renderCursorDebugIngestSettings(containerEl: HTMLElement): void {
    const device = readDeviceSettings();
    const isLinked = hasCachedIngestConnection();
    const ingestDocs = document.createDocumentFragment();
    ingestDocs.appendText(
      "Live Cursor Debug ingest (device-local). On the Mac: write the offer (via /debug-ingest), run ",
    );
    ingestDocs.createEl("code", { text: "bash scripts/ingest-lan-relay.sh" });
    ingestDocs.appendText(
      ". This computer auto-connects when Debug logging is on; other devices tap Connect. See ",
    );
    const ingestLink = ingestDocs.createEl("a", {
      text: "Cursor Debug ingest",
      href: `${DOCS_BASE}/cursor-debug-ingest.md`,
    });
    ingestLink.setAttr("target", "_blank");
    ingestDocs.appendText(".");

    new Setting(containerEl).setName("Cursor Debug ingest").setDesc(ingestDocs).setHeading();

    new Setting(containerEl)
      .setName("Connect")
      .setDesc(
        isLinked
          ? "Connected for this Debug era. Turn Debug logging off to clear."
          : Platform.isMobile
            ? "Finds the Mac offer sidecar on Wi‑Fi (localhost, cache, then short LAN probe)."
            : "Looks for the offer on this computer (127.0.0.1). Usually auto-connects when Debug logging turns on.",
      )
      .addButton((btn) => {
        btn.setButtonText(isLinked ? connectedButtonLabel() : "Connect");
        if (isLinked) {
          btn.setDisabled(true);
        } else {
          btn.onClick(async () => {
            btn.setDisabled(true);
            btn.setButtonText("Connecting…");
            const result = await connectCursorDebugIngest();
            if (result.ok) {
              // Success Notice is shown inside connect() (~8s).
              this.display();
              return;
            }
            btn.setDisabled(false);
            btn.setButtonText("Connect");
            new Notice(result.reason);
          });
        }
      });

    const canaryDesc = isCursorDebugIngestConfigured()
      ? "Writes a canary line to the vault log and POSTs to Cursor ingest."
      : "Writes a canary line to the vault log. Connect (or Advanced fields) to also POST to Cursor.";

    new Setting(containerEl)
      .setName("Send test log")
      .setDesc(canaryDesc)
      .addButton((btn) =>
        btn.setButtonText("Send test log").onClick(async () => {
          if (!this.plugin.settings.debugLoggingEnabled) {
            new Notice("Enable Debug logging first.");
            return;
          }
          await this.plugin.sendDebugLogCanary();
          new Notice(
            isCursorDebugIngestConfigured()
              ? "Test log sent (vault + Cursor ingest)."
              : "Test log written to vault (Cursor ingest not configured).",
          );
        }),
      );

    // Emergency manual paste — Connect should be enough for normal Debug sessions.
    const advanced = containerEl.createEl("details", { cls: "dbx-debug-ingest-advanced" });
    advanced.createEl("summary", { text: "Advanced" });
    const advancedBody = advanced.createDiv({ cls: "dbx-debug-ingest-advanced-body" });

    new Setting(advancedBody)
      .setName("Host")
      .setDesc(
        Platform.isMobile
          ? "Mac LAN IP (filled by Connect)."
          : "Filled by Connect. Empty host falls back to 127.0.0.1 for desktop POSTs.",
      )
      .addText((text) =>
        text
          .setPlaceholder("192.168.x.x")
          .setValue(device.cursorDebugHost)
          .onChange((value) => {
            patchDeviceSettings({ cursorDebugHost: value.trim() });
          }),
      );

    new Setting(advancedBody)
      .setName("Port")
      .setDesc(`Cursor ingest port (default ${DEFAULT_CURSOR_DEBUG_PORT}). Must match the LAN relay.`)
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_CURSOR_DEBUG_PORT))
          .setValue(String(device.cursorDebugPort))
          .onChange((value) => {
            const parsed = Number.parseInt(value.trim(), 10);
            if (Number.isFinite(parsed) && parsed > 0 && parsed < 65536) {
              patchDeviceSettings({ cursorDebugPort: parsed });
            }
          }),
      );

    new Setting(advancedBody)
      .setName("Session ID")
      .setDesc("Short slug from the Cursor Debug session (X-Debug-Session-Id / debug-<slug>.log).")
      .addText((text) =>
        text
          .setPlaceholder("e7cde3")
          .setValue(device.cursorDebugSessionId)
          .onChange((value) => {
            patchDeviceSettings({ cursorDebugSessionId: value.trim() });
          }),
      );

    new Setting(advancedBody)
      .setName("Ingest path")
      .setDesc("Path from Cursor Debug, e.g. /ingest/<uuid>. Not the same as the session slug.")
      .addText((text) =>
        text
          .setPlaceholder("/ingest/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")
          .setValue(device.cursorDebugIngestPath)
          .onChange((value) => {
            patchDeviceSettings({ cursorDebugIngestPath: value.trim() });
          }),
      );
  }

  // ── 인증 (미연결 시) ──
  private renderAuth(containerEl: HTMLElement): void {
    if (Platform.isDesktop) {
      this.renderDesktopAuth(containerEl);
    } else {
      this.renderMobileAuth(containerEl);
    }
  }

  private renderSyncSection(containerEl: HTMLElement, hasSyncName: boolean): void {
    if (!hasSyncName) {
      this.renderSyncNameSetup(containerEl);
    }
  }

  private renderBackgroundSyncSection(containerEl: HTMLElement, autoSyncOn: boolean): void {
    new Setting(containerEl)
      .setName("Automatic background sync")
      .setDesc("These options apply only to automatic sync — not to Sync now.")
      .setHeading();

    new Setting(containerEl)
      .setName("Enable automatic background sync")
      .setDesc(
        "When on: sync on a timer, when files change, and when Dropbox reports changes. "
        + "When off: only runs when you choose Sync now.",
      )
      .addToggle((toggle) =>
        toggle.setValue(autoSyncOn).onChange(async (value) => {
          if (value) {
            await this.plugin.enableBackgroundSync();
          } else {
            await this.plugin.disableBackgroundSync();
          }
          this.display();
        }),
      );

    const sectionKeys: VaultSection[] = ["notes", "settings", "plugins", "workspaces"];
    const sectionLabels: Record<VaultSection, string> = {
      notes: SYNC_SCOPE_LABELS.notes,
      settings: SYNC_SCOPE_LABELS.settings,
      plugins: SYNC_SCOPE_LABELS.plugins,
      workspaces: SYNC_SCOPE_LABELS.workspaces,
    };

    new Setting(containerEl)
      .setName("Sections for background sync")
      .setDesc(
        "Which parts of the vault automatic sync includes. "
        + "Manual Sync now chooses sections separately in its modal. At least one must be enabled.",
      );

    for (const key of sectionKeys) {
      new Setting(containerEl)
        .setName(sectionLabels[key])
        .setDesc("Background sync only")
        .addToggle((toggle) => {
          toggle.setValue(this.plugin.settings.backgroundSyncSections[key]).onChange(async (value) => {
            const sections = { ...this.plugin.settings.backgroundSyncSections };
            if (!value && countEnabledBackgroundSections(sections) <= 1 && sections[key]) {
              new Notice("At least one section must be enabled for background sync.");
              toggle.setValue(true);
              return;
            }
            sections[key] = value;
            this.plugin.settings.backgroundSyncSections = sections;
            await this.plugin.saveSettings();
          });
        });
    }

    new Setting(containerEl)
      .setName("Sync interval (seconds)")
      .setDesc("Background only — fallback interval when no file changes are detected.")
      .addSlider((slider) =>
        slider
          .setLimits(30, 600, 30)
          .setValue(this.plugin.settings.syncInterval)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.syncInterval = value;
            await this.plugin.saveSettings();
          }),
      );

    const debounceIdx = debounceSecToSliderIndex(this.plugin.settings.vaultEventDebounceSec);
    const debounceSetting = new Setting(containerEl)
      .setName("File change debounce")
      .setDesc(this.debounceDesc(this.plugin.settings.vaultEventDebounceSec))
      .addSlider((slider) => {
        slider
          .setLimits(0, VAULT_EVENT_DEBOUNCE_OPTIONS.length - 1, 1)
          .setValue(debounceIdx)
          .onChange(async (value) => {
            const sec = VAULT_EVENT_DEBOUNCE_OPTIONS[value] ?? VAULT_EVENT_DEBOUNCE_OPTIONS[0];
            this.plugin.settings.vaultEventDebounceSec = sec;
            debounceSetting.setDesc(this.debounceDesc(sec));
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Sync on file create")
      .setDesc(
        "Background only — trigger sync when new files are created. "
        + "Edits, deletions, and renames always trigger background sync when it is enabled.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncOnCreateDeleteRename)
          .onChange(async (value) => {
            this.plugin.settings.syncOnCreateDeleteRename = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Large sync progress threshold")
      .setDesc(
        "When a background sync plans more than this many file actions, show the progress bar "
        + "and allow cancel like Sync now. Default 10.",
      )
      .addSlider((slider) =>
        slider
          .setLimits(1, 100, 1)
          .setValue(this.plugin.settings.largeSyncInteractiveThreshold)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.largeSyncInteractiveThreshold = value;
            await this.plugin.saveSettings();
          }),
      );
  }

  /** Explains that Sync now picks sections in the modal, separate from background toggles. */
  private renderManualSyncSection(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Manual sync")
      .setDesc("These apply when you tap Sync now — not to automatic background sync.")
      .setHeading();

    new Setting(containerEl)
      .setName("Choose sections each run")
      .setDesc(
        "Sync now opens a modal where you pick notes, Obsidian settings, plugins, and workspaces. "
        + "Those choices do not change the background section toggles above.",
      )
      .addButton((btn) =>
        btn.setButtonText("Sync now").onClick(() => this.plugin.openSyncScopeModal()),
      );
  }

  private debounceDesc(sec: number): string {
    return `Background only — wait ${sec}s after a file edit, delete, or rename before starting a sync.`;
  }

  // 최초 설정: 이름 입력 + Set
  private renderSyncNameSetup(containerEl: HTMLElement): void {
    const rawName = this.app.vault.getName().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100);
    const defaultName = isValidSyncName(rawName) ? rawName : "vault";
    let inputName = defaultName;
    let setBtnEl: HTMLButtonElement | null = null;
    const setting = new Setting(containerEl)
      .setName("Vault ID")
      .setDesc("Letters, numbers, hyphens, underscores only.")
      .addText((text) =>
        text
          .setPlaceholder(defaultName)
          .setValue(defaultName)
          .onChange((value) => {
            inputName = value.trim();
            const valid = isValidSyncName(inputName);
            if (setBtnEl) setBtnEl.disabled = !valid;
            setting.setDesc(
              valid || !inputName
                ? "Letters, numbers, hyphens, underscores only."
                : `Invalid name: "${inputName}". Use only a-z, 0-9, -, _`,
            );
          }),
      )
      .addButton((btn) => {
        btn
          .setButtonText("Set")
          .setCta()
          .onClick(async () => {
            if (!isValidSyncName(inputName)) {
              new Notice("Invalid vault ID.");
              return;
            }
            const fileCount = await this.plugin.checkRemoteFolder(inputName);
            if (fileCount !== null) {
              const confirmed = await new ConfirmModal(
                this.app,
                "Folder already exists",
                `"${inputName}" already has ${fileCount}+ files on Dropbox.`,
                "Your local vault will be synced with this existing folder. "
                + "This may overwrite local or remote files.",
              ).waitForConfirmation();
              if (!confirmed) return;
            }
            this.plugin.settings.syncName = inputName;
            await this.plugin.saveSettings();
            this.plugin.resetEngine();
            new Notice(`Vault ID set: ${inputName}`);
            this.display();
          });
        setBtnEl = btn.buttonEl;
        setBtnEl.disabled = !isValidSyncName(defaultName);
      });
  }

  // 이름 변경: Connection 섹션 안에서 변경 (위험 경고)
  private renderSyncNameChange(containerEl: HTMLElement, savedName: string): void {
    let pendingName = savedName;
    let changeBtnEl: HTMLButtonElement | null = null;

    const setting = new Setting(containerEl)
      .setName("Change vault ID")
      .addText((text) =>
        text.setValue(savedName).onChange((value) => {
          pendingName = value.trim();
          const valid = isValidSyncName(pendingName);
          const changed = valid && pendingName !== savedName;
          if (changeBtnEl) {
            changeBtnEl.disabled = !changed;
            changeBtnEl.toggleClass("mod-cta", changed);
          }
          setting.setDesc(
            !pendingName || valid
              ? ""
              : `Invalid name. Use only a-z, 0-9, -, _`,
          );
        }),
      )
      .addButton((btn) => {
        btn
          .setButtonText("Change")
          .onClick(async () => {
            if (!isValidSyncName(pendingName)) {
              new Notice("Invalid vault ID. Use only letters, numbers, hyphens, underscores.");
              return;
            }
            if (pendingName === savedName) return;

            const fileCount = await this.plugin.checkRemoteFolder(pendingName);
            const exists = fileCount !== null;

            const confirmed = await new ConfirmModal(
              this.app,
              `"${savedName}" → "${pendingName}"`,
              exists
                ? `"${pendingName}" already has ${fileCount}+ files on Dropbox.`
                : `"${pendingName}" is a new folder on Dropbox.`,
              exists
                ? "Changing will stop syncing with the current folder. "
                  + "Your local vault will merge with the existing remote folder. "
                  + "This may cause conflicts or data overwrite."
                : "Changing will stop syncing with the current folder. "
                  + "Files in \"" + savedName + "\" on Dropbox will remain untouched. "
                  + "A full upload to the new folder will occur on next sync.",
            ).waitForConfirmation();
            if (!confirmed) return;
            this.plugin.settings.syncName = pendingName;
            await this.plugin.saveSettings();
            this.plugin.resetEngine();
            new Notice(`Vault ID changed: ${pendingName}`);
            this.display();
          });
        changeBtnEl = btn.buttonEl;
        changeBtnEl.disabled = true;
      });
  }

  private renderDisconnect(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Connected to Dropbox")
      .addButton((btn) =>
        btn
          .setButtonText("Disconnect")
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.refreshToken = "";
            this.plugin.settings.accessToken = "";
            this.plugin.settings.tokenExpiry = 0;
            this.plugin.settings.backgroundSyncEnabled = false;
            await this.plugin.saveSettings();
            this.display();
          }),
      );
  }

  // ── 데스크톱: 원클릭 인증 ──
  private renderDesktopAuth(containerEl: HTMLElement): void {
    const appKey = getEffectiveAppKey(this.plugin.settings);

    if (!appKey) {
      new Setting(containerEl)
        .setName("Setup required")
        .setDesc(
          "No app key configured. Set your app key below first.",
        );
      return;
    }

    new Setting(containerEl)
      .setName("Connect to Dropbox")
      .setDesc(
        "Opens Dropbox in your browser. After authorization, you'll be redirected back automatically.",
      )
      .addButton((btn) =>
        btn
          .setButtonText("Connect")
          .setCta()
          .onClick(() => this.plugin.startAuth()),
      );
  }

  // ── 모바일: 2단계 수동 인증 ──
  private renderMobileAuth(containerEl: HTMLElement): void {
    const appKey = getEffectiveAppKey(this.plugin.settings);

    if (!appKey) {
      new Setting(containerEl)
        .setName("Setup required")
        .setDesc(
          "No app key configured. Set your app key below first.",
        );
      return;
    }

    // Step 1: 인증 URL 열기
    new Setting(containerEl)
      .setName("Step 1: authorize")
      .setDesc("Open Dropbox in your browser to authorize this plugin.")
      .addButton((btn) =>
        btn
          .setButtonText("Open Dropbox")
          .setCta()
          .onClick(async () => {
            this.codeVerifier = generateCodeVerifier();
            const challenge = await generateCodeChallenge(this.codeVerifier);
            const url = buildAuthUrl({ appKey, codeChallenge: challenge });
            window.location.href = url;
          }),
      );

    // Step 2: 인증 코드 입력
    let authCodeInput = "";
    new Setting(containerEl)
      .setName("Step 2: enter authorization code")
      .setDesc("Paste the code from Dropbox here.")
      .addText((text) =>
        text
          .setPlaceholder("Authorization code")
          .onChange((value) => {
            authCodeInput = value.trim();
          }),
      )
      .addButton((btn) =>
        btn.setButtonText("Connect").onClick(async () => {
          if (!authCodeInput || !this.codeVerifier) {
            new Notice("Please complete step 1 first, then paste the code.");
            return;
          }
          try {
            const tokenInfo = await exchangeCodeForToken(
              obsidianHttpClient,
              appKey,
              authCodeInput,
              this.codeVerifier,
            );
            this.plugin.settings.accessToken = tokenInfo.accessToken;
            this.plugin.settings.refreshToken = tokenInfo.refreshToken;
            this.plugin.settings.tokenExpiry = tokenInfo.expiresAt;
            await this.plugin.saveSettings();
            this.codeVerifier = null;
            new Notice("Connected to Dropbox!");
            this.display();
          } catch (e) {
            new Notice(`Connection failed: ${(e as Error).message}`);
          }
        }),
      );
  }

  /** Conflict / exclude / hidden apply to both background and manual runs. */
  private renderSharedSyncOptions(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Shared sync options")
      .setDesc("These apply to both automatic background sync and manual Sync now.")
      .setHeading();

    const strategyDescs: Record<string, string> = {
      keep_both: "Both versions are kept. Remote version is saved as a .conflict file.",
      newest: "The newer version wins, based on modification time.",
      manual: "A merge modal opens so you can compare and choose per section.",
    };

    const conflictDesc = (strategy: string) => {
      const frag = document.createDocumentFragment();
      frag.appendText(strategyDescs[strategy] ?? "");
      frag.appendText(" ");
      const link = frag.createEl("a", { text: "Learn more", href: `${DOCS_BASE}/conflict-resolution.md` });
      link.setAttr("target", "_blank");
      return frag;
    };

    const strategySetting = new Setting(containerEl)
      .setName("Conflict strategy")
      .setDesc(conflictDesc(this.plugin.settings.conflictStrategy))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("keep_both", "Keep both versions")
          .addOption("newest", "Keep newest")
          .addOption("manual", "Ask me")
          .setValue(this.plugin.settings.conflictStrategy)
          .onChange(async (value) => {
            this.plugin.settings.conflictStrategy = value as ConflictStrategy;
            strategySetting.setDesc(conflictDesc(value));
            await this.plugin.saveSettings();
          }),
      );

    const excludeSetting = new Setting(containerEl)
      .setName("Exclude patterns")
      .setDesc(
        "Files matching these patterns won't sync (one per line). Defaults include .git/, plugin state, and sync logs — remove a line to allow that path to sync.",
      )
      .addTextArea((text) => {
        text
          .setValue(this.plugin.settings.excludePatterns.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.excludePatterns = value
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
            this.plugin.resetEngine();
            this.updateExcludeCount(excludeSetting);
          });
        text.inputEl.rows = 4;
        text.inputEl.addClass("dbx-sync-settings-exclude-textarea");
      });
    this.updateExcludeCount(excludeSetting);

    new Setting(containerEl)
      .setName("Include hidden files and folders")
      .setDesc(
        "Deep-scan the vault on disk for other dotfiles and folders Obsidian does not index "
        + "(for example .git when not excluded). Slower on large vaults. "
        + "Does not control .obsidian — use the Obsidian settings / plugins / workspaces "
        + "section toggles for that; those always sync when enabled.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.includeHiddenFilesAndFolders)
          .onChange(async (value) => {
            this.plugin.settings.includeHiddenFilesAndFolders = value;
            await this.plugin.saveSettings();
            this.plugin.resetEngine();
          }),
      );
  }

  private renderAdvancedSafety(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Safety")
      .setDesc("Applies to both automatic and manual sync.")
      .setHeading();

    const deleteDesc = (() => {
      const frag = document.createDocumentFragment();
      frag.appendText("Warn before deleting more files than the threshold. ");
      const link = frag.createEl("a", { text: "Learn more", href: `${DOCS_BASE}/sync-safety.md` });
      link.setAttr("target", "_blank");
      return frag;
    })();

    new Setting(containerEl)
      .setName("Delete protection")
      .setDesc(deleteDesc)
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.deleteProtection)
          .onChange(async (value) => {
            this.plugin.settings.deleteProtection = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Delete threshold")
      .setDesc("Number of deletions that triggers protection (default 5).")
      .addSlider((slider) =>
        slider
          .setLimits(1, 50, 1)
          .setValue(this.plugin.settings.deleteThreshold)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.deleteThreshold = value;
            await this.plugin.saveSettings();
          }),
      );
  }

  // ── App Key (disconnect 상태에서만 변경 가능) ──
  private renderAppKey(containerEl: HTMLElement): void {
    const isConnected = !!this.plugin.settings.refreshToken;

    if (DEFAULT_APP_KEY) {
      const appKeyDesc = (() => {
        const frag = document.createDocumentFragment();
        frag.appendText(isConnected
          ? "Disconnect first to change App Key. "
          : "Override the built-in App Key with your own. ");
        const link = frag.createEl("a", { text: "Setup guide", href: `${DOCS_BASE}/custom-app-key.md` });
        link.setAttr("target", "_blank");
        return frag;
      })();

      new Setting(containerEl)
        .setName("Use custom app key")
        .setDesc(appKeyDesc)
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.useCustomAppKey)
            .setDisabled(isConnected)
            .onChange(async (value) => {
              this.plugin.settings.useCustomAppKey = value;
              await this.plugin.saveSettings();
              this.display();
            }),
        );
    }

    if (this.plugin.settings.useCustomAppKey || !DEFAULT_APP_KEY) {
      new Setting(containerEl)
        .setName("App key")
        .setDesc(
          isConnected
            ? "Disconnect first to change App Key."
            : "Create an app at dropbox.com/developers/apps",
        )
        .addText((text) =>
          text
            .setPlaceholder(DEFAULT_APP_KEY || "Your App Key")
            .setValue(this.plugin.settings.appKey)
            .setDisabled(isConnected)
            .onChange(async (value) => {
              this.plugin.settings.appKey = value.trim();
              await this.plugin.saveSettings();
            }),
        );
    }
  }

  private updateExcludeCount(setting: Setting): void {
    const patterns = this.plugin.settings.excludePatterns;
    const allFiles = this.app.vault.getFiles();
    const excluded = allFiles.filter((f: TFile) => isExcluded(f.path, patterns));
    const base =
      "Files matching these patterns won't sync (one per line). Defaults include .git/, plugin state, and sync logs — remove a line to allow that path to sync.";
    if (patterns.length === 0) {
      setting.setDesc(base);
      return;
    }
    setting.setDesc(`${base} Currently: ${excluded.length} of ${allFiles.length} local file(s) excluded.`);
  }
}
