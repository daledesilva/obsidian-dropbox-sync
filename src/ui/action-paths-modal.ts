import { App, Modal, Notice, Setting } from "obsidian";

/** Live chip modal row — attempt/retry log until successes settle into path lists. */
export type ChipLogKind = "attempt" | "retrying" | "success" | "failed";

export interface ChipLogLine {
  kind: ChipLogKind;
  path: string;
  /** Optional error snippet for failed rows. */
  text?: string;
}

/**
 * Read-only list of paths (or live activity log lines) for one sync summary chip.
 * Copy joins paths with newlines. While sync runs, appendLine/appendPath grows the list.
 */
export class ActionPathsModal extends Modal {
  private countEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private emptyEl: HTMLElement | null = null;
  private onCloseCallback: (() => void) | null = null;
  private lines: ChipLogLine[];
  /** When true, count label uses "events" (live log) instead of "files". */
  private useEventCount: boolean;

  constructor(
    app: App,
    private title: string,
    pathsOrLines: string[] | ChipLogLine[],
    options?: { useEventCount?: boolean },
  ) {
    super(app);
    this.lines = normalizeToLines(pathsOrLines);
    this.useEventCount = options?.useEventCount ?? hasLiveLogKinds(this.lines);
  }

  /** Called when the modal closes so the progress panel can drop its live reference. */
  setOnCloseCallback(callback: (() => void) | null): void {
    this.onCloseCallback = callback;
  }

  onOpen(): void {
    const { contentEl } = this;
    // Use the modal title bar — not an h3 inside the body.
    this.setTitle(this.title);
    this.countEl = contentEl.createEl("p", {
      text: this.formatCountLabel(),
      cls: "setting-item-description",
    });

    this.emptyEl = contentEl.createEl("p", {
      text: "Waiting for activity…",
      cls: "setting-item-description dbx-sync-action-paths-empty",
    });
    this.emptyEl.toggleClass("dbx-sync-action-paths-empty-hidden", this.lines.length > 0);

    // Scrollable full list (no hard 20-cap) — chip modals are informational, not confirmations.
    this.listEl = contentEl.createDiv({ cls: "dbx-sync-action-paths-list" });
    for (const line of this.lines) {
      this.appendLineRow(line);
    }

    // One path per line so the clipboard paste is usable in editors / spreadsheets.
    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Copy to clipboard")
          .setCta()
          .onClick(async () => {
            const paths = this.lines.map((line) => line.path);
            await navigator.clipboard.writeText(paths.join("\n"));
            new Notice(
              paths.length === 1
                ? "Path copied to clipboard"
                : "Paths copied to clipboard",
            );
          }),
      )
      .addButton((btn) =>
        btn.setButtonText("Close").onClick(() => this.close()),
      );
  }

  /** Replace with finished path list (count-only files mode). */
  setPaths(paths: string[]): void {
    this.useEventCount = false;
    this.setLines(paths.map((path) => ({ kind: "success" as const, path })));
  }

  /** Replace the full line list (e.g. reconcile after markResult or reopen). */
  setLines(lines: ChipLogLine[], options?: { useEventCount?: boolean }): void {
    this.lines = lines.map(cloneLine).filter((line) => line.path.trim().length > 0);
    if (options?.useEventCount !== undefined) {
      this.useEventCount = options.useEventCount;
    }
    this.refreshCount();
    this.emptyEl?.toggleClass("dbx-sync-action-paths-empty-hidden", this.lines.length > 0);
    if (!this.listEl) return;
    this.listEl.empty();
    for (const line of this.lines) {
      this.appendLineRow(line);
    }
  }

  /**
   * Append one completed path while the modal stays open.
   * Auto-scrolls when the user is already near the bottom so live sync feels continuous.
   */
  appendPath(path: string): void {
    this.appendLine({ kind: "success", path });
  }

  /** Append one live log line (attempt / retrying / success / failed). */
  appendLine(line: ChipLogLine): void {
    const trimmed = line.path.trim();
    if (!trimmed) return;
    const next: ChipLogLine = { ...line, path: trimmed };
    this.lines.push(next);
    if (next.kind !== "success") {
      this.useEventCount = true;
    }
    this.refreshCount();
    this.emptyEl?.addClass("dbx-sync-action-paths-empty-hidden");
    if (!this.listEl) return;
    const nearBottom = this.isListNearBottom();
    this.appendLineRow(next);
    if (nearBottom) {
      this.listEl.scrollTop = this.listEl.scrollHeight;
    }
  }

  onClose(): void {
    this.countEl = null;
    this.listEl = null;
    this.emptyEl = null;
    this.contentEl.empty();
    const callback = this.onCloseCallback;
    this.onCloseCallback = null;
    callback?.();
  }

  private formatCountLabel(): string {
    const count = this.lines.length;
    if (this.useEventCount) {
      return count === 1 ? "1 event:" : `${count} events:`;
    }
    return count === 1 ? "1 file:" : `${count} files:`;
  }

  private refreshCount(): void {
    this.countEl?.setText(this.formatCountLabel());
  }

  private appendLineRow(line: ChipLogLine): void {
    if (!this.listEl) return;
    const label = formatChipLogLine(line);
    this.listEl.createDiv({
      cls: `dbx-sync-action-paths-path dbx-sync-action-paths-kind-${line.kind}`,
      text: label,
      attr: { title: label },
    });
  }

  /** True when scrolled within ~48px of the bottom (or list not yet scrollable). */
  private isListNearBottom(): boolean {
    if (!this.listEl) return true;
    const remaining =
      this.listEl.scrollHeight - this.listEl.scrollTop - this.listEl.clientHeight;
    return remaining <= 48;
  }
}

function cloneLine(line: ChipLogLine): ChipLogLine {
  return { kind: line.kind, path: line.path, text: line.text };
}

function normalizeToLines(pathsOrLines: string[] | ChipLogLine[]): ChipLogLine[] {
  if (pathsOrLines.length === 0) return [];
  if (typeof pathsOrLines[0] === "string") {
    return (pathsOrLines as string[])
      .map((path) => path.trim())
      .filter(Boolean)
      .map((path) => ({ kind: "success" as const, path }));
  }
  return (pathsOrLines as ChipLogLine[]).map(cloneLine).filter((line) => line.path.trim());
}

function hasLiveLogKinds(lines: ChipLogLine[]): boolean {
  return lines.some((line) => line.kind !== "success");
}

/** Human-readable row for the chip modal log. */
export function formatChipLogLine(line: ChipLogLine): string {
  const path = line.path.trim();
  switch (line.kind) {
    case "attempt":
      return path;
    case "retrying":
      return `retrying  ${path}`;
    case "failed":
      return line.text?.trim()
        ? `failed  ${path} — ${line.text.trim()}`
        : `failed  ${path}`;
    case "success":
      return path;
  }
}
