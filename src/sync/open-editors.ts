import { App, MarkdownView, type WorkspaceLeaf } from "obsidian";

/** Find the markdown leaf editing `path`, if any. */
export function findMarkdownLeafForPath(app: App, path: string): WorkspaceLeaf | null {
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const view = leaf.view;
    if (view instanceof MarkdownView && view.file?.path === path) {
      return leaf;
    }
  }
  return null;
}

/** True when Obsidian exposes an unsaved buffer for `path` in any markdown tab. */
export function isFileDirtyInOpenEditor(app: App, path: string): boolean {
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const view = leaf.view;
    if (!(view instanceof MarkdownView) || view.file?.path !== path) continue;
    if (isMarkdownViewDirty(view)) return true;
  }
  return false;
}

function isMarkdownViewDirty(view: MarkdownView): boolean {
  const editor = view.editor as { isDirty?: () => boolean } | undefined;
  if (editor && typeof editor.isDirty === "function") {
    try {
      return editor.isDirty();
    } catch {
      return false;
    }
  }
  return false;
}

/** True when `path` is the active file or has a dirty unsaved buffer (G19). */
export function shouldDeferApplyForOpenEditors(app: App, path: string): boolean {
  if (app.workspace.getActiveFile()?.path === path) return true;
  return isFileDirtyInOpenEditor(app, path);
}

/**
 * Reload disk contents into an open markdown view and restore scroll when possible.
 * Row 18 expects in-place reload after a bounded deferral expires.
 */
export async function reloadOpenMarkdownFile(app: App, path: string): Promise<void> {
  const leaf = findMarkdownLeafForPath(app, path);
  if (!leaf) return;
  const view = leaf.view;
  if (!(view instanceof MarkdownView) || !view.file) return;

  const scrollTop = readMarkdownScrollTop(view);
  const wasActive = app.workspace.activeLeaf === leaf;
  const file = view.file;
  let diskText: string;
  try {
    diskText = await app.vault.read(file);
  } catch {
    return;
  }

  // Prefer in-place buffer replace — setViewState alone often keeps a stale CM buffer.
  const editor = view.editor;
  if (editor.getValue() !== diskText) {
    const cursor = editor.getCursor();
    editor.setValue(diskText);
    try {
      editor.setCursor(cursor);
    } catch {
      /* cursor restore is best-effort after length changes */
    }
  }

  const previous = leaf.getViewState();
  await leaf.setViewState(
    {
      ...previous,
      type: "markdown",
      state: {
        ...(previous.state as Record<string, unknown> | undefined),
        file: file.path,
      },
      active: wasActive,
    },
    { history: false },
  );
  if (wasActive) {
    app.workspace.setActiveLeaf(leaf, { focus: false });
  }
  const reloaded = leaf.view;
  if (reloaded instanceof MarkdownView) {
    restoreMarkdownScrollTop(reloaded, scrollTop);
  }
}

function readMarkdownScrollTop(view: MarkdownView): number | undefined {
  const mode = view.currentMode as { getScroll?: () => number } | undefined;
  if (mode && typeof mode.getScroll === "function") {
    try {
      return mode.getScroll();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function restoreMarkdownScrollTop(view: MarkdownView, scrollTop: number | undefined): void {
  if (scrollTop === undefined) return;
  const mode = view.currentMode as { setScroll?: (scroll: number) => void } | undefined;
  if (mode && typeof mode.setScroll === "function") {
    try {
      mode.setScroll(scrollTop);
    } catch {
      /* scroll restore is best-effort */
    }
  }
}
