import type { FileInfo, SyncEntry, SyncPlan } from "../types";
import type { RemoteEntry } from "../types";
import { classifyVaultPath, type VaultSection } from "./sync-scope";

export type DeleteIntentSource = "event" | "inferred" | "persisted";

export interface SyncCycleDiagnostics {
  local: {
    /** Files from vault.getFiles() before disk merge. */
    vaultIndexed: number;
    configDiskAdded: number;
    hiddenDiskAdded: number;
    mergedAfterExclude: number;
    inScope: number;
    outOfScope: number;
    bySection: Record<VaultSection, number>;
  };
  syncState: {
    baseInScope: number;
    remoteInScope: number;
    basePlugins: number;
    remotePlugins: number;
    localPlugins: number;
  };
  deleteIntent: {
    totalInLog: number;
    fromVaultEvents: number;
    fromPersistedLog: number;
    inferredThisCycle: number;
    inferredSample: string[];
    inferredSkippedPlugin: number;
  };
  deletePlan: {
    deleteRemote: number;
    deleteLocal: number;
    deleteRemoteBySource: Record<string, number>;
    deleteRemoteSample: string[];
  };
  deleteGuard?: {
    triggered: boolean;
    totalDeletes: number;
    deleteRemote: number;
    deleteLocal: number;
    threshold: number;
    passed: boolean;
    skipped?: number;
  };
}

const SECTIONS: VaultSection[] = ["notes", "settings", "plugins", "workspaces"];

export function emptySectionCounts(): Record<VaultSection, number> {
  return { notes: 0, settings: 0, plugins: 0, workspaces: 0 };
}

export function countLocalBySection(
  files: FileInfo[],
  configDir: string,
): Record<VaultSection, number> {
  const counts = emptySectionCounts();
  for (const f of files) {
    counts[classifyVaultPath(f.path, configDir)]++;
  }
  return counts;
}

export function countDeleteIntentSources(
  deletedPaths: Iterable<string>,
  sources: Map<string, DeleteIntentSource>,
): { event: number; inferred: number; persisted: number } {
  let event = 0;
  let inferred = 0;
  let persisted = 0;
  for (const p of deletedPaths) {
    const src = sources.get(p);
    if (src === "event") event++;
    else if (src === "inferred") inferred++;
    else if (src === "persisted") persisted++;
  }
  return { event, inferred, persisted };
}

export function summarizeDeletePlan(
  plan: SyncPlan,
  sources: Map<string, DeleteIntentSource>,
): SyncCycleDiagnostics["deletePlan"] {
  const deleteRemoteBySource: Record<string, number> = {};
  const deleteRemoteSample: string[] = [];
  let deleteRemote = 0;
  let deleteLocal = 0;

  for (const item of plan.items) {
    if (item.action.type === "deleteRemote") {
      deleteRemote++;
      const src = sources.get(item.pathLower) ?? "none";
      deleteRemoteBySource[src] = (deleteRemoteBySource[src] ?? 0) + 1;
      if (deleteRemoteSample.length < 8) {
        deleteRemoteSample.push(item.localPath);
      }
    } else if (item.action.type === "deleteLocal") {
      deleteLocal++;
    }
  }

  return { deleteRemote, deleteLocal, deleteRemoteBySource, deleteRemoteSample };
}

export function formatDiagnosticsForLog(d: SyncCycleDiagnostics): Record<string, unknown> {
  return {
    local: d.local,
    syncState: d.syncState,
    deleteIntent: d.deleteIntent,
    deletePlan: d.deletePlan,
    deleteGuard: d.deleteGuard,
  };
}

/** Markdown section for sync-logs summary. */
export function formatDiagnosticsMarkdown(d: SyncCycleDiagnostics): string[] {
  const lines: string[] = ["## Diagnostics", ""];

  lines.push("### Local scan");
  lines.push(`- Vault indexed (getFiles): **${d.local.vaultIndexed}**`);
  lines.push(`- Config disk added: **${d.local.configDiskAdded}**`);
  lines.push(`- Hidden disk added: **${d.local.hiddenDiskAdded}**`);
  lines.push(`- Merged after excludes: **${d.local.mergedAfterExclude}**`);
  lines.push(`- In current sync scope: **${d.local.inScope}**`);
  lines.push(`- Out of scope (section): **${d.local.outOfScope}**`);
  for (const s of SECTIONS) {
    if (d.local.bySection[s] > 0) {
      lines.push(`- In scope · ${s}: **${d.local.bySection[s]}**`);
    }
  }
  lines.push("");

  lines.push("### Sync state (in scope)");
  lines.push(`- Base entries: **${d.syncState.baseInScope}**`);
  lines.push(`- Remote files: **${d.syncState.remoteInScope}**`);
  lines.push(
    `- Plugins · local **${d.syncState.localPlugins}** / base **${d.syncState.basePlugins}** / remote **${d.syncState.remotePlugins}**`,
  );
  lines.push("");

  lines.push("### Delete intent (before plan)");
  lines.push(`- Total paths in delete log: **${d.deleteIntent.totalInLog}**`);
  lines.push(`- From Obsidian delete/rename events: **${d.deleteIntent.fromVaultEvents}**`);
  lines.push(`- Restored from persisted log: **${d.deleteIntent.fromPersistedLog}**`);
  lines.push(
    `- Inferred this cycle (in base+remote, missing from local scan): **${d.deleteIntent.inferredThisCycle}**`,
  );
  if (d.deleteIntent.inferredSkippedPlugin > 0) {
    lines.push(
      `- Plugin infer skipped (incomplete scan guard): **${d.deleteIntent.inferredSkippedPlugin}**`,
    );
  }
  if (d.deleteIntent.inferredSample.length > 0) {
    lines.push("- Inferred sample:");
    for (const p of d.deleteIntent.inferredSample) {
      lines.push(`  - \`${p}\``);
    }
  }
  lines.push("");

  lines.push("### Planned deletions");
  lines.push(`- deleteRemote: **${d.deletePlan.deleteRemote}**`);
  lines.push(`- deleteLocal: **${d.deletePlan.deleteLocal}**`);
  if (d.deletePlan.deleteRemote > 0) {
    const parts = Object.entries(d.deletePlan.deleteRemoteBySource)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}: ${n}`);
    if (parts.length > 0) {
      lines.push(`- deleteRemote by intent source: ${parts.join(", ")}`);
    }
    if (d.deletePlan.deleteRemoteSample.length > 0) {
      lines.push("- deleteRemote sample:");
      for (const p of d.deletePlan.deleteRemoteSample) {
        lines.push(`  - \`${p}\``);
      }
    }
  }

  if (d.deleteGuard?.triggered) {
    lines.push("");
    lines.push("### Delete protection");
    lines.push(
      `- **${d.deleteGuard.totalDeletes}** deletions (remote: ${d.deleteGuard.deleteRemote}, local: ${d.deleteGuard.deleteLocal}), threshold **${d.deleteGuard.threshold}**`,
    );
    lines.push(
      `- ${d.deleteGuard.passed ? "Within threshold (no modal)" : `Blocked — ${d.deleteGuard.skipped ?? d.deleteGuard.totalDeletes} skipped pending confirmation`}`,
    );
  }

  lines.push("");
  return lines;
}

/** Live-report lines during sync. */
export function emitDiagnosticsPhaseLines(
  report: { line(text: string): void } | null,
  phase: "scan" | "intent" | "plan" | "guard",
  d: SyncCycleDiagnostics,
): void {
  if (!report) return;
  switch (phase) {
    case "scan":
      report.line(
        `vault indexed: **${d.local.vaultIndexed}**, config disk: **${d.local.configDiskAdded}**, hidden disk: **${d.local.hiddenDiskAdded}**, merged: **${d.local.mergedAfterExclude}**`,
      );
      report.line(
        `in scope: **${d.local.inScope}**, out of scope: **${d.local.outOfScope}**`,
      );
      if (
        d.syncState.localPlugins > 0
        || d.syncState.basePlugins > 0
        || d.syncState.remotePlugins > 0
      ) {
        report.line(
          `plugins · local **${d.syncState.localPlugins}** / base **${d.syncState.basePlugins}** / remote **${d.syncState.remotePlugins}**`,
        );
      }
      for (const s of SECTIONS) {
        if (d.local.bySection[s] > 0) {
          report.line(`in scope · ${s}: **${d.local.bySection[s]}**`);
        }
      }
      break;
    case "intent":
      report.line(
        `delete log: **${d.deleteIntent.totalInLog}** total (events: **${d.deleteIntent.fromVaultEvents}**, persisted: **${d.deleteIntent.fromPersistedLog}**, inferred now: **${d.deleteIntent.inferredThisCycle}**)`,
      );
      if (d.deleteIntent.inferredSkippedPlugin > 0) {
        report.line(`plugin infer skipped: **${d.deleteIntent.inferredSkippedPlugin}** paths`);
      }
      for (const p of d.deleteIntent.inferredSample.slice(0, 5)) {
        report.line(`inferred sample: \`${p}\``);
      }
      break;
    case "plan":
      if (d.deletePlan.deleteRemote > 0 || d.deletePlan.deleteLocal > 0) {
        report.line(
          `planned deletes: remote **${d.deletePlan.deleteRemote}**, local **${d.deletePlan.deleteLocal}**`,
        );
        const parts = Object.entries(d.deletePlan.deleteRemoteBySource)
          .filter(([, n]) => n > 0)
          .map(([k, n]) => `${k}=${n}`);
        if (parts.length > 0) {
          report.line(`deleteRemote intent: ${parts.join(", ")}`);
        }
        for (const p of d.deletePlan.deleteRemoteSample.slice(0, 3)) {
          report.line(`deleteRemote sample: \`${p}\``);
        }
      }
      break;
    case "guard":
      if (d.deleteGuard?.triggered && !d.deleteGuard.passed) {
        report.line(
          `delete protection: **${d.deleteGuard.totalDeletes}** deletions blocked (threshold **${d.deleteGuard.threshold}**)`,
        );
      }
      break;
  }
}

export function countRemotePlugins(
  remoteMap: Map<string, RemoteEntry>,
  configDir: string,
): number {
  let n = 0;
  for (const entry of remoteMap.values()) {
    if (entry.deleted) continue;
    const path = entry.pathDisplay || entry.pathLower;
    if (classifyVaultPath(path, configDir) === "plugins") n++;
  }
  return n;
}

export function countBasePlugins(baseEntries: SyncEntry[], configDir: string): number {
  let n = 0;
  for (const e of baseEntries) {
    if (classifyVaultPath(e.localPath, configDir) === "plugins") n++;
  }
  return n;
}

/** Skip inferring plugin deletes when local scan is far below base (incomplete index). */
export function shouldSkipPluginInfer(
  pluginsSectionActive: boolean,
  localPlugins: number,
  basePlugins: number,
): boolean {
  return pluginsSectionActive && basePlugins > 20 && localPlugins < basePlugins * 0.5;
}
