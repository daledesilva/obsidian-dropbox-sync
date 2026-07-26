import { mock } from "bun:test";

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\//, "");
}

// obsidian 모듈 mock
class TAbstractFile {
  path = "";
  children: TAbstractFile[] = [];
}
class TFile extends TAbstractFile {
  stat = { mtime: 0, size: 0 };
  extension = "md";
}
class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}
class FileManager {
  async renameFile(): Promise<void> {}
  async trashFile(): Promise<void> {}
}
class Vault {
  configDir = ".obsidian";
  getRoot(): TFolder {
    return new TFolder();
  }
}

mock.module("obsidian", () => ({
  normalizePath,
  TAbstractFile,
  TFile,
  TFolder,
  FileManager,
  Vault,
  requestUrl(): never {
    throw new Error("requestUrl is not available in tests");
  },
  Notice: class Notice {
    constructor(_message: string, _duration?: number) {}
  },
  setIcon(_el: HTMLElement, _icon: string): void {},
  Plugin: class Plugin {},
  PluginSettingTab: class PluginSettingTab {},
  Setting: class Setting {},
  Platform: {
    isDesktop: true,
    isMobile: false,
    isDesktopApp: true,
    isMobileApp: false,
    isIosApp: false,
  },
}));

// 빌드 타임 상수
(globalThis as any).__DROPBOX_APP_KEY__ = "";
