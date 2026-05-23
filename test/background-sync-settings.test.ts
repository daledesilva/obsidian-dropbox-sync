import { describe, test, expect } from "bun:test";
import {
  debounceSecToSliderIndex,
  DEFAULT_BACKGROUND_SYNC_SECTIONS,
  DEFAULT_SETTINGS,
  formatBackgroundSectionsLabel,
  getEnabledBackgroundSections,
  migrateSettings,
  snapVaultEventDebounceSec,
  VAULT_EVENT_DEBOUNCE_OPTIONS,
} from "@/settings";

describe("snapVaultEventDebounceSec", () => {
  test("snaps to nearest option", () => {
    expect(snapVaultEventDebounceSec(2)).toBe(2);
    expect(snapVaultEventDebounceSec(3)).toBe(2);
    expect(snapVaultEventDebounceSec(7)).toBe(5);
    expect(snapVaultEventDebounceSec(45)).toBe(30);
    expect(snapVaultEventDebounceSec(99)).toBe(60);
  });
});

describe("debounceSecToSliderIndex", () => {
  test("maps each snap point to index", () => {
    for (let i = 0; i < VAULT_EVENT_DEBOUNCE_OPTIONS.length; i++) {
      expect(debounceSecToSliderIndex(VAULT_EVENT_DEBOUNCE_OPTIONS[i])).toBe(i);
    }
  });
});

describe("getEnabledBackgroundSections", () => {
  test("default is notes only", () => {
    expect(getEnabledBackgroundSections(DEFAULT_SETTINGS)).toEqual(["notes"]);
  });

  test("returns multiple enabled sections", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      backgroundSyncSections: {
        notes: true,
        settings: false,
        plugins: true,
        workspaces: false,
      },
    };
    expect(getEnabledBackgroundSections(settings)).toEqual(["notes", "plugins"]);
  });

  test("falls back to notes when all disabled", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      backgroundSyncSections: {
        notes: false,
        settings: false,
        plugins: false,
        workspaces: false,
      },
    };
    expect(getEnabledBackgroundSections(settings)).toEqual(["notes"]);
  });
});

describe("formatBackgroundSectionsLabel", () => {
  test("joins section labels", () => {
    expect(formatBackgroundSectionsLabel(["notes", "plugins"])).toBe(
      "Notes & files, Obsidian plugins",
    );
  });
});

describe("migrateSettings", () => {
  test("handles null/undefined saved data (first enable)", () => {
    expect(migrateSettings(null)).toEqual({
      backgroundSyncSections: DEFAULT_BACKGROUND_SYNC_SECTIONS,
      vaultEventDebounceSec: 2,
    });
    expect(migrateSettings(undefined)).toEqual({
      backgroundSyncSections: DEFAULT_BACKGROUND_SYNC_SECTIONS,
      vaultEventDebounceSec: 2,
    });
  });

  test("adds defaults for missing background fields", () => {
    const migrated = migrateSettings({});
    expect(migrated.backgroundSyncSections).toEqual(DEFAULT_BACKGROUND_SYNC_SECTIONS);
    expect(migrated.vaultEventDebounceSec).toBe(2);
  });

  test("snaps invalid debounce value", () => {
    const migrated = migrateSettings({ vaultEventDebounceSec: 7 as never });
    expect(migrated.vaultEventDebounceSec).toBe(5);
  });
});
