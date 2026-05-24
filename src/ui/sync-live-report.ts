import { TFile, normalizePath, type App } from "obsidian";
import {
  buildSyncLogPath,
  buildSyncSummaryMarkdown,
  ensureSyncLogsFolder,
  type SyncReportInput,
} from "./sync-feedback";
const FLUSH_LINE_COUNT = 25;
const PROGRESS_LINE_RE = /^\*Progress:.*\*$/m;

export type LiveReportPhase = 1 | 2 | 3 | 4 | 5;

const PHASE_TITLES: Record<LiveReportPhase, string> = {
  1: "Local scan",
  2: "Remote fetch",
  3: "Plan",
  4: "Path guard",
  5: "Execute",
};

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export interface SyncLiveReportMeta {
  startedAt: number;
  deviceId: string;
  version: string;
  scope?: string;
}

export interface SyncLiveReportSink {
  phaseStart(phase: LiveReportPhase): Promise<void>;
  line(text: string): void;
  /** Single updating progress line (execute phase). */
  progressLine(summary: string): void;
  phaseEnd(summary: string): Promise<void>;
}

/**
 * Append-only markdown sync report created at sync start.
 * Buffers lines and flushes to the vault file periodically.
 */
export class SyncLiveReport implements SyncLiveReportSink {
  private path: string | null = null;
  private buffer = "";
  private lineCount = 0;
  private openPhase: LiveReportPhase | null = null;

  private constructor(
    private app: App,
    private meta: SyncLiveReportMeta,
  ) {}

  static async open(app: App, meta: SyncLiveReportMeta): Promise<SyncLiveReport> {
    const report = new SyncLiveReport(app, meta);
    await report.createFile();
    await report.appendRaw("\n> Sync in progress…\n");
    return report;
  }

  get filePath(): string | null {
    return this.path;
  }

  async phaseStart(phase: LiveReportPhase): Promise<void> {
    await this.flush();
    this.openPhase = phase;
    await this.appendRaw(`\n## ${phase}. ${PHASE_TITLES[phase]}\n\n`);
  }

  /** Queue a bullet line under the current phase. */
  line(text: string): void {
    this.buffer += `- ${text}\n`;
    this.lineCount++;
    if (this.lineCount >= FLUSH_LINE_COUNT) {
      void this.flush();
    }
  }

  /** Replace the single *Progress: …* line in the report (throttle callers). */
  progressLine(summary: string): void {
    void this.writeProgressLine(`*Progress: ${summary}*`);
  }

  async phaseEnd(summary: string): Promise<void> {
    await this.appendRaw(`\n*Phase complete: ${summary}*\n`);
    this.openPhase = null;
  }

  async finalize(input: SyncReportInput): Promise<string | null> {
    await this.flush();
    await this.appendRaw("\n---\n\n");
    await this.appendRaw(buildSyncSummaryMarkdown(input));
    return this.path;
  }

  private async createFile(): Promise<void> {
    const vault = this.app.vault;
    this.path = buildSyncLogPath(this.meta.startedAt);

    const header = [
      `# Dropbox Sync — ${formatTimestamp(this.meta.startedAt)}`,
      "",
      `**Started:** ${formatTimestamp(this.meta.startedAt)}`,
      `**Device:** ${this.meta.deviceId || "unknown"} · v${this.meta.version}`,
      this.meta.scope ? `**Scope:** ${this.meta.scope}` : "",
      "",
      "Per-file log (updates during sync):",
    ].join("\n") + "\n";

    try {
      await ensureSyncLogsFolder(this.app);
      await vault.create(this.path, header);
    } catch (e) {
      console.error(`[Dropbox Sync] failed to create ${this.path} via vault API`, e);
      try {
        await vault.adapter.write(normalizePath(this.path), header);
      } catch {
        throw e;
      }
    }
  }

  private async appendRaw(text: string): Promise<void> {
    if (!this.path) return;
    const file = this.app.vault.getAbstractFileByPath(this.path);
    if (!(file instanceof TFile)) return;
    const tfile = file;
    const existing = await this.app.vault.read(tfile);
    await this.app.vault.modify(tfile, existing + text);
  }

  private async flush(): Promise<void> {
    if (!this.path || this.buffer.length === 0) return;
    const chunk = this.buffer;
    this.buffer = "";
    this.lineCount = 0;
    await this.appendRaw(chunk);
  }

  private async writeProgressLine(line: string): Promise<void> {
    if (!this.path) return;
    const file = this.app.vault.getAbstractFileByPath(this.path);
    if (!(file instanceof TFile)) return;
    let content = await this.app.vault.read(file);
    content = content.replace(PROGRESS_LINE_RE, "").replace(/\n{3,}/g, "\n\n");
    if (!content.endsWith("\n")) content += "\n";
    content += `${line}\n`;
    await this.app.vault.modify(file, content);
  }
}
