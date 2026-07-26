import type { CursorDebugLogMeta } from "@/debug/cursor-debug-ingest";
import { createSyncMonitorLog, type SyncMonitorLog } from "@/debug/sync-monitor";

export type RecordedLog = {
  message: string;
  data?: Record<string, unknown>;
  meta?: CursorDebugLogMeta;
};

/** Captures sync monitor log lines for scenario-matrix assertions. */
export class RecordingLog {
  records: RecordedLog[] = [];

  asSyncMonitorLog(): SyncMonitorLog {
    return createSyncMonitorLog((message, data, meta) => {
      this.records.push({
        message,
        data: data as Record<string, unknown> | undefined,
        meta,
      });
    });
  }

  findByRule(ruleId: string): RecordedLog[] {
    return this.records.filter((record) => {
      const id = record.meta?.ruleId;
      if (Array.isArray(id)) return id.includes(ruleId);
      return id === ruleId;
    });
  }

  findByMessage(substr: string): RecordedLog[] {
    return this.records.filter((record) => record.message.includes(substr));
  }

  clear(): void {
    this.records.length = 0;
  }
}
