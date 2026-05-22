import { mock } from "bun:test";

// obsidian 모듈 mock
mock.module("obsidian", () => ({
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
