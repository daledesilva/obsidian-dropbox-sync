/**
 * Obsidian popout-safe localStorage access.
 * Prefer window.activeWindow so settings written in a popout stay on that window's storage.
 */
function getLocalStorage(): Storage | null {
  try {
    const active = (window as Window & { activeWindow?: Window }).activeWindow;
    return (active ?? window).localStorage;
  } catch {
    return null;
  }
}

export function fetchLocally(key: string): string | null {
  try {
    return getLocalStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function saveLocally(key: string, value: string): void {
  try {
    getLocalStorage()?.setItem(key, value);
  } catch {
    /* quota / private mode — ignore */
  }
}
