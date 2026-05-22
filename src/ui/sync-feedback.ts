import { Notice, setIcon, type App, type Vault } from "obsidian";
import type { SyncPlan, SyncResult } from "../types";
import { PathValidationError, LocalPathError } from "../types";
import { summarizeActions } from "../sync/sync-reporter";

const RIBBON_ICON = "refresh-cw";
const RIBBON_CLASS_SYNCING = "dbx-sync-ribbon-syncing";
const REPORTS_DIR = ".sync-reports";

export type SyncOutcome =
  | "success"
  | "partial"
  | "failed"
  | "up_to_date"
  | "aborted"
  | "auth_error"
  | "renamed_resync"
  | "error";

export interface SyncReportInput {
  startedAt: number;
  endedAt: number;
  outcome: SyncOutcome;
  plan?: SyncPlan;
  result?: SyncResult;
  deletesSkipped?: number;
  deferredCount?: number;
  pathsSkipped?: number;
  errorMessage?: string;
  deviceId: string;
  version: string;
}

export function setRibbonSyncing(ribbonEl: HTMLElement | null, syncing: boolean): void {
  if (!ribbonEl) return;
  const wasSyncing = ribbonEl.hasClass(RIBBON_CLASS_SYNCING);
  ribbonEl.toggleClass(RIBBON_CLASS_SYNCING, syncing);
  if (wasSyncing !== syncing) {
    setIcon(ribbonEl, RIBBON_ICON);
  }
  ribbonEl.setAttr("aria-label", syncing ? "Stop sync" : "Dropbox sync");
}

export function notifySyncStart(): void {
  new Notice("Dropbox Sync: syncing…", 3000);
}

export function notifySyncEnd(message: string, durationMs = 5000): void {
  new Notice(message, durationMs);
}

/** Status bar + notice message from engine result. */
export function buildSyncResultFeedback(
  result: SyncResult,
  deletesSkipped?: number,
  pathsSkipped?: number,
): { outcome: SyncOutcome; summary: string; endMessage: string; noticeDuration: number } {
  if (result.failed.length > 0) {
    const summary = `${result.failed.length} failed, ${result.succeeded.length} ok`;
    const first = result.failed[0];
    const detail = first.error?.message?.slice(0, 100) ?? "";
    const pathHint =
      first.error instanceof PathValidationError || first.error instanceof LocalPathError
        ? "\nFix names via the incompatible-files prompt on next sync."
        : "";
    return {
      outcome: "failed",
      summary,
      endMessage: `Dropbox Sync: ${summary}\n${first.item.localPath}: ${detail}${pathHint}`,
      noticeDuration: 8000,
    };
  }
  if (pathsSkipped && pathsSkipped > 0) {
    const summary = `${summarizeActions(result.succeeded)}, ${pathsSkipped} paths skipped`;
    return {
      outcome: "partial",
      summary,
      endMessage: `Dropbox Sync: ${pathsSkipped} file(s) skipped (incompatible names). Other changes synced.`,
      noticeDuration: 6000,
    };
  }
  if (deletesSkipped && deletesSkipped > 0) {
    const summary = `${summarizeActions(result.succeeded)}, ${deletesSkipped} deletes skipped`;
    return {
      outcome: "partial",
      summary,
      endMessage: `Dropbox Sync: ${summarizeActions(result.succeeded)}, ${deletesSkipped} deletions skipped by protection.`,
      noticeDuration: 5000,
    };
  }
  if (result.succeeded.length > 0) {
    const summary = summarizeActions(result.succeeded);
    return {
      outcome: "success",
      summary,
      endMessage: `Dropbox Sync: ${summary}`,
      noticeDuration: 5000,
    };
  }
  return {
    outcome: "up_to_date",
    summary: "up to date",
    endMessage: "Dropbox Sync: up to date",
    noticeDuration: 4000,
  };
}

export function shouldWriteSyncReport(
  manual: boolean,
  input: Pick<SyncReportInput, "outcome" | "result" | "deletesSkipped" | "pathsSkipped" | "deferredCount">,
): boolean {
  if (manual) return true;
  if (input.outcome === "aborted" || input.outcome === "auth_error" || input.outcome === "renamed_resync") {
    return false;
  }
  if (input.outcome !== "up_to_date") return true;
  const result = input.result;
  if (!result) return false;
  return (
    result.succeeded.length > 0
    || result.failed.length > 0
    || result.deferred.length > 0
    || (input.deletesSkipped ?? 0) > 0
    || (input.pathsSkipped ?? 0) > 0
  );
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatFileTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function outcomeLabel(outcome: SyncOutcome): string {
  switch (outcome) {
    case "success": return "Success";
    case "partial": return "Partial";
    case "failed": return "Failed";
    case "up_to_date": return "Up to date";
    case "aborted": return "Cancelled";
    case "auth_error": return "Auth error";
    case "renamed_resync": return "Renamed — resync scheduled";
    case "error": return "Error";
  }
}

export function buildSyncSummaryMarkdown(input: SyncReportInput): string {
  const durationSec = ((input.endedAt - input.startedAt) / 1000).toFixed(1);
  const lines: string[] = [
    `# Dropbox Sync — ${formatTimestamp(input.endedAt)}`,
    "",
    `**Status:** ${outcomeLabel(input.outcome)}`,
    `**Duration:** ${durationSec}s`,
    `**Device:** ${input.deviceId || "unknown"} · v${input.version}`,
  ];

  const result = input.result;
  if (result) {
    const summary =
      result.failed.length > 0
        ? `${result.failed.length} failed, ${result.succeeded.length} ok`
        : result.succeeded.length > 0
          ? summarizeActions(result.succeeded)
          : "up to date";
    lines.push(`**Summary:** ${summary}`);
  } else if (input.errorMessage) {
    lines.push(`**Summary:** ${input.errorMessage}`);
  }

  lines.push("");

  const stats = input.plan?.stats;
  if (stats) {
    lines.push("## Plan stats", "", "| Action | Count |", "| --- | --- |");
    for (const [key, value] of Object.entries(stats)) {
      if (value > 0) lines.push(`| ${key} | ${value} |`);
    }
    lines.push("");
  }

  if (input.deletesSkipped) {
    lines.push(`- ${input.deletesSkipped} deletion(s) skipped by protection`);
  }
  if (input.pathsSkipped) {
    lines.push(`- ${input.pathsSkipped} path(s) skipped (incompatible names)`);
  }
  if (input.deferredCount) {
    lines.push(`- ${input.deferredCount} item(s) deferred (active file protection)`);
  }

  if (result && result.failed.length > 0) {
    lines.push("", "## Failed", "");
    for (const f of result.failed) {
      lines.push(`- \`${f.item.localPath}\` (${f.item.action.type}): ${f.error?.message ?? "unknown error"}`);
    }
  }

  if (result && result.succeeded.length > 0) {
    lines.push("", "## Succeeded", "");
    for (const item of result.succeeded) {
      lines.push(`- \`${item.localPath}\` — ${item.action.type}`);
    }
  }

  if (input.errorMessage && input.outcome !== "failed") {
    lines.push("", "## Error", "", input.errorMessage);
  }

  return lines.join("\n") + "\n";
}

export async function writeSyncReport(
  app: App,
  markdown: string,
  deviceId: string,
  endedAt: number,
): Promise<string | null> {
  const vault = app.vault;
  const folder = REPORTS_DIR;
  const existing = vault.getAbstractFileByPath(folder);
  if (!existing) {
    try {
      await vault.createFolder(folder);
    } catch {
      // folder may exist from a race
    }
  }

  const suffix = deviceId ? `-${deviceId}` : "";
  const filename = `sync-${formatFileTimestamp(endedAt)}${suffix}.md`;
  const path = `${folder}/${filename}`;

  try {
    await vault.create(path, markdown);
    return path;
  } catch (e) {
    console.error("[Dropbox Sync] failed to write sync report:", e);
    return null;
  }
}
