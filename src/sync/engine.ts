import type { FileSystem, RemoteStorage, SyncStateStore } from "../adapters/interfaces";
import type { PathGuardIssue, PathIssueResolution, RemoteEntry, SyncPlan, SyncResult } from "../types";
import { checkPathGuard } from "./path-guard";
import { createPlan } from "./planner";
import type { ConflictStrategy, ConflictResolver, DeleteGuardResult } from "../types";
import { executePlan } from "./executor";
import { checkDeleteGuard } from "./guards";
import { DropboxAdapter, DropboxCursorResetError } from "../adapters/dropbox-adapter";
import { isExcluded } from "../exclude";
import { CycleContext } from "./cycle-context";
import type { SyncLiveReportSink } from "../ui/sync-live-report";
import { VaultAdapter, type LocalFileScanCallback } from "../adapters/vault-adapter";
import { isPathInScope, isPathInSections, type SyncScope, type VaultSection } from "./sync-scope";

/** conflict 파일 판별 (.conflict-YYYY-MM-DDTHHMM 패턴) */
export function isConflictFile(path: string): boolean {
  return /\.conflict-\d{4}-\d{2}-\d{2}t\d{4}/i.test(path);
}

export interface SyncEngineDeps {
  fs: FileSystem;
  remote: RemoteStorage;
  store: SyncStateStore;
}

export interface SyncEngineOptions {
  conflictStrategy?: ConflictStrategy;
  conflictResolver?: ConflictResolver;
  deleteProtection?: boolean;
  deleteThreshold?: number;
  /** 대량 삭제 시 사용자 확인 콜백. true면 삭제 실행, false면 스킵 */
  onDeleteGuardTriggered?: (guard: DeleteGuardResult) => Promise<boolean>;
  /** 파일이 현재 편집 중인지 확인. true면 download/conflict를 건너뛴다 */
  isFileActive?: (path: string) => boolean;
  /** 파일 제외 패턴 */
  excludePatterns?: string[];
  /** 병렬 실행 동시성. 기본값 1 (순차) */
  concurrency?: number;
  /** 항목 실행 완료 시마다 호출. (완료 수, 전체 수, 실패 수) */
  onProgress?: (completed: number, total: number, failed: number) => void;
  /** conflict 직렬 실행 전 호출. conflict 총 수 전달. */
  onConflictCount?: (count: number) => void;
  /** 사이클 리포트 활성화 */
  enableCycleReports?: boolean;
  /** 사이클 리포트 저장 콜백 */
  onCycleReport?: (report: string, cycleId: string) => Promise<void>;
  /** iOS/모바일에서 로컬 경로 규칙 적용 */
  strictLocalPaths?: boolean;
  /** 호환되지 않는 경로 감지 시 모달 등 처리 */
  onPathIssues?: (issues: PathGuardIssue[]) => Promise<PathIssueResolution>;
}

export interface CycleResult {
  plan: SyncPlan;
  result: SyncResult;
  /** 삭제 가드에 의해 스킵된 항목 수 */
  deletesSkipped?: number;
  /** 활성 파일 보호로 건너뛴 항목 수 */
  deferredCount?: number;
  /** 경로 rename 적용됨 — 재동기화 필요 */
  pathRenamesApplied?: boolean;
  /** 경로 문제로 스킵한 항목 수 */
  pathsSkipped?: number;
  /** 사이클 리포트 (JSONL) */
  cycleReport?: string;
}

/**
 * 동기화 엔진.
 * runCycle()로 한 번의 동기화 사이클을 실행한다.
 *
 * 1. 로컬 파일 수집 + hash 계산
 * 2. 원격 변경 수집 (cursor 기반 delta)
 * 3. 이전 상태(base) 로드
 * 4. base + delta 병합 → 전체 원격 상태 구성
 * 5. Planner로 동기화 계획 생성 (삭제 의도 전달)
 * 6. 삭제 가드 적용
 * 7. Executor로 계획 실행
 * 8. 모두 성공 시에만 cursor 갱신
 */
export class SyncEngine {
  private deletedPaths = new Set<string>();
  private liveReport: SyncLiveReportSink | null = null;
  private syncScope: SyncScope = "everything";
  private sectionFilter: VaultSection[] | null = null;
  private configDir = ".obsidian";

  constructor(
    private deps: SyncEngineDeps,
    private options: SyncEngineOptions = {},
  ) {}

  /** Per-sync live markdown report (set before each runCycle). */
  setLiveReport(report: SyncLiveReportSink | null): void {
    this.liveReport = report;
  }

  /** 동기화 범위 — manual single scope (set before each runCycle). */
  setSyncScope(scope: SyncScope, configDir: string): void {
    this.syncScope = scope;
    this.sectionFilter = null;
    this.configDir = configDir;
  }

  /** Background sync — multiple vault sections (set before each runCycle). */
  setSyncSections(sections: VaultSection[], configDir: string): void {
    this.sectionFilter = sections;
    this.configDir = configDir;
  }

  private pathInScope(path: string): boolean {
    const patterns = this.options.excludePatterns ?? [];
    if (this.sectionFilter) {
      return isPathInSections(path, this.sectionFilter, this.configDir, patterns);
    }
    return isPathInScope(path, this.syncScope, this.configDir, patterns);
  }

  /** 로컬 삭제 이벤트 기록 */
  trackDelete(pathLower: string): void {
    this.deletedPaths.add(pathLower);
  }

  /** 잘못 기록된 삭제 의도 제거 (경로 rename 등) */
  clearDeleteIntent(pathLower: string): void {
    this.deletedPaths.delete(pathLower);
  }

  /** 저장된 삭제 로그에서 복원 */
  restoreDeleteLog(paths: string[]): void {
    for (const p of paths) {
      this.deletedPaths.add(p);
    }
  }

  /** 현재 삭제 로그 반환 (영속화용) */
  getDeleteLog(): string[] {
    return [...this.deletedPaths];
  }

  /** 미소비 삭제 항목 존재 여부 */
  hasPendingDeletes(): boolean {
    return this.deletedPaths.size > 0;
  }

  async runCycle(signal?: AbortSignal): Promise<CycleResult> {
    const { fs, remote, store } = this.deps;
    this.attachAbortSignal(signal);
    try {
      return await this.runCycleInner(signal);
    } finally {
      this.attachAbortSignal(undefined);
    }
  }

  private attachAbortSignal(signal?: AbortSignal): void {
    if (this.deps.fs instanceof VaultAdapter) {
      this.deps.fs.setAbortSignal(signal ?? null);
    }
    if (this.deps.remote instanceof DropboxAdapter) {
      this.deps.remote.setAbortSignal(signal);
    }
  }

  private async runCycleInner(signal?: AbortSignal): Promise<CycleResult> {
    const { fs, remote, store } = this.deps;
    const ctx = this.options.enableCycleReports ? new CycleContext() : undefined;

    // 0. 사이클 시작 이벤트
    if (ctx) {
      const cursor = await store.getMeta("cursor");
      ctx.emit({ type: "cycle_start", ts: ctx.startTime, cursor: cursor ?? null });
    }

    // 1. 로컬 파일 수집
    signal?.throwIfAborted();
    const localScanStart = Date.now();
    await this.liveReport?.phaseStart(1);
    const localScanCb: LocalFileScanCallback = (path, detail) => {
      this.liveReport?.line(`\`${path}\` (${detail})`);
    };
    this.attachLocalScanCallback(localScanCb);
    let localFiles: import("../types").FileInfo[];
    try {
      localFiles = this.collectLocalFiles(await fs.list()).filter((f) =>
        this.pathInScope(f.path),
      );
    } finally {
      this.attachLocalScanCallback(null);
    }
    await this.liveReport?.phaseEnd(`${localFiles.length} file(s) scanned`);
    ctx?.emit({ type: "local_scan", ts: Date.now(), fileCount: localFiles.length, duration: Date.now() - localScanStart });

    // 2. 원격 변경 수집 (delta)
    await this.liveReport?.phaseStart(2);
    const { deltaEntries, latestCursor, inScopeDeltaCount } = await this.fetchRemoteDeltas(
      store,
      remote,
      signal,
      ctx,
    );
    await this.liveReport?.phaseEnd(
      `${inScopeDeltaCount} in-scope remote entry/entries (${deltaEntries.length} delta total)`,
    );

    // 3. 이전 상태 로드
    signal?.throwIfAborted();
    const baseEntries = (await store.getAllEntries()).filter((e) =>
      this.pathInScope(e.localPath),
    );

    // 4. base + delta 병합 → 전체 원격 상태
    const fullRemoteMap = this.buildFullRemoteState(baseEntries, deltaEntries);
    this.filterRemoteMapByScope(fullRemoteMap);

    // 5. catch-up: vault 이벤트 누락 보완
    this.inferMissingDeletes(localFiles, fullRemoteMap, baseEntries);

    // 6. 동기화 계획 생성
    signal?.throwIfAborted();
    const fullRemoteEntries = Array.from(fullRemoteMap.values());
    await this.liveReport?.phaseStart(3);
    let planItemsLogged = 0;
    const plan = createPlan(localFiles, fullRemoteEntries, baseEntries, {
      localDeletedPaths: this.deletedPaths,
      ctx,
      onPlanItem: (pathLower, localPath, actionType, reason) => {
        if (planItemsLogged < 15) {
          this.liveReport?.line(`\`${localPath}\` → **${actionType}** (${reason})`);
          planItemsLogged++;
        }
      },
    });
    if (plan.items.length > planItemsLogged) {
      this.liveReport?.line(`… and ${plan.items.length - planItemsLogged} more planned`);
    }
    await this.liveReport?.phaseEnd(`${plan.items.length} action(s), ${plan.stats.noop} noop(s)`);

    // 7. 삭제 가드 적용
    const { planToExecute, deletesSkipped } = await this.applyDeleteGuard(plan, ctx);

    // 7b. 경로 호환성 가드
    let planToRun = planToExecute;
    let pathsSkipped = 0;
    await this.liveReport?.phaseStart(4);
    const pathGuard = checkPathGuard(planToRun, this.options.strictLocalPaths ?? false);
    if (!pathGuard.passed) {
      for (const issue of pathGuard.issues) {
        const types = issue.issues.map((i) => i.message).join("; ");
        this.liveReport?.line(
          `blocked \`${issue.item.localPath}\` (${issue.item.action.type}): ${types}`,
        );
      }
      if (this.options.onPathIssues) {
        const resolution = await this.options.onPathIssues(pathGuard.issues);
        if (resolution.action === "renamed") {
          const pairs = resolution.renames.map((r) => `\`${r.from}\` → \`${r.to}\``).join(", ");
          this.liveReport?.line(`resolution: **renamed** (${pairs})`);
          await this.liveReport?.phaseEnd("renames applied — execution deferred to next sync");
          return {
            plan,
            result: { succeeded: [], failed: [], deferred: [] },
            deletesSkipped,
            pathRenamesApplied: true,
          };
        }
        if (resolution.action === "skip") {
          this.liveReport?.line("resolution: **skip** incompatible paths");
        }
        planToRun = pathGuard.filteredPlan;
        pathsSkipped = pathGuard.issues.length;
      } else {
        planToRun = pathGuard.filteredPlan;
        pathsSkipped = pathGuard.issues.length;
      }
    }
    await this.liveReport?.phaseEnd(
      pathGuard.passed
        ? "all paths compatible"
        : `${pathsSkipped} blocked, ${planToRun.items.length} remaining in plan`,
    );

    // 8. 계획 실행
    signal?.throwIfAborted();
    await this.liveReport?.phaseStart(5);
    let execFailed = 0;
    const result = await executePlan(planToRun, { fs, remote, store }, {
      conflictStrategy: this.options.conflictStrategy,
      conflictResolver: this.options.conflictResolver,
      isFileActive: this.options.isFileActive,
      signal,
      concurrency: this.options.concurrency,
      onProgress: (completed, total) => {
        if (completed % 10 === 0 || completed === total) {
          this.liveReport?.progressLine(
            `${completed} / ${total} (${execFailed} failed)`,
          );
        }
        this.options.onProgress?.(completed, total, execFailed);
      },
      onConflictCount: this.options.onConflictCount,
      strictLocalPaths: this.options.strictLocalPaths,
      ctx,
      onExecItem: (localPath, actionType, event, ok, error) => {
        if (event === "end" && !ok) {
          execFailed++;
          this.liveReport?.line(`\`${localPath}\` — ${actionType} ✗ ${error ?? ""}`);
        }
      },
    });
    await this.liveReport?.phaseEnd(
      `${result.succeeded.length} ok, ${result.failed.length} failed, ${result.deferred.length} deferred`,
    );

    // 9. 상태 갱신
    await this.finalizeState(store, result, latestCursor, deletesSkipped);

    const deferredCount = result.deferred.length > 0 ? result.deferred.length : undefined;

    // 10. 사이클 종료 이벤트 + 리포트
    if (ctx) {
      ctx.emit({
        type: "cycle_end",
        ts: Date.now(),
        duration: Date.now() - ctx.startTime,
        stats: plan.stats as unknown as Record<string, number>,
        failed: result.failed.length,
        deferred: result.deferred.length,
      });

      const report = ctx.toJsonl();
      await this.options.onCycleReport?.(report, ctx.cycleId);

      return { plan, result, deletesSkipped, deferredCount, pathsSkipped: pathsSkipped || undefined, cycleReport: report };
    }

    return { plan, result, deletesSkipped, deferredCount, pathsSkipped: pathsSkipped || undefined };
  }

  // ── private helpers ──

  private filterRemoteMapByScope(map: Map<string, RemoteEntry>): void {
    for (const key of [...map.keys()]) {
      const entry = map.get(key)!;
      const path = entry.pathDisplay || entry.pathLower;
      if (!this.pathInScope(path)) {
        map.delete(key);
      }
    }
  }

  private attachLocalScanCallback(cb: LocalFileScanCallback | null): void {
    if (this.deps.fs instanceof VaultAdapter) {
      this.deps.fs.onLocalFileScanned = cb;
    }
  }

  /** conflict 파일을 제외한 로컬 파일 목록 */
  private collectLocalFiles(files: import("../types").FileInfo[]): import("../types").FileInfo[] {
    return files.filter((f) => !isConflictFile(f.path));
  }

  /** cursor 기반 원격 delta 수집 (cursor 만료 시 전체 재스캔) */
  private async fetchRemoteDeltas(
    store: import("../adapters/interfaces").SyncStateStore,
    remote: import("../adapters/interfaces").RemoteStorage,
    signal?: AbortSignal,
    ctx?: CycleContext,
  ): Promise<{ deltaEntries: RemoteEntry[]; latestCursor: string; inScopeDeltaCount: number }> {
    let cursor = await store.getMeta("cursor");
    const fetchStart = Date.now();
    let changes;
    try {
      changes = await remote.listChanges(cursor ?? undefined);
    } catch (e) {
      if (e instanceof DropboxCursorResetError && cursor) {
        ctx?.emit({ type: "cursor_reset", ts: Date.now(), oldCursor: cursor });
        await store.setMeta("cursor", "");
        cursor = null;
        changes = await remote.listChanges();
      } else {
        throw e;
      }
    }

    let deltaEntries = [...changes.entries];
    let latestCursor = changes.cursor;
    let hasMore = changes.hasMore;
    let loggedInScope = 0;
    for (const entry of changes.entries) {
      const path = entry.pathDisplay || entry.pathLower;
      if (!this.pathInScope(path)) continue;
      loggedInScope++;
      const tag = entry.deleted ? "deleted" : "file";
      this.liveReport?.line(`\`${entry.pathDisplay}\` (${tag}, rev ${entry.rev ?? "—"})`);
    }

    ctx?.emit({
      type: "remote_fetch",
      ts: Date.now(),
      deltaCount: deltaEntries.length,
      cursor: latestCursor,
      hasMore,
      duration: Date.now() - fetchStart,
    });

    while (hasMore) {
      signal?.throwIfAborted();
      const pageStart = Date.now();
      const more = await remote.listChanges(latestCursor);
      for (const entry of more.entries) {
        const path = entry.pathDisplay || entry.pathLower;
        if (!this.pathInScope(path)) continue;
        loggedInScope++;
        const tag = entry.deleted ? "deleted" : "file";
        this.liveReport?.line(`\`${entry.pathDisplay}\` (${tag}, rev ${entry.rev ?? "—"})`);
      }
      deltaEntries = deltaEntries.concat(more.entries);
      latestCursor = more.cursor;
      hasMore = more.hasMore;
      ctx?.emit({
        type: "remote_fetch",
        ts: Date.now(),
        deltaCount: more.entries.length,
        cursor: latestCursor,
        hasMore,
        duration: Date.now() - pageStart,
      });
    }

    return { deltaEntries, latestCursor, inScopeDeltaCount: loggedInScope };
  }

  /** base + delta 병합 → 전체 원격 상태 맵 (제외 패턴 적용 포함) */
  private buildFullRemoteState(
    baseEntries: import("../types").SyncEntry[],
    deltaEntries: RemoteEntry[],
  ): Map<string, RemoteEntry> {
    const fullRemoteMap = new Map<string, RemoteEntry>();

    for (const base of baseEntries) {
      if (base.baseRemoteHash && base.rev) {
        fullRemoteMap.set(base.pathLower, {
          pathLower: base.pathLower,
          pathDisplay: base.localPath,
          hash: base.baseRemoteHash,
          serverModified: base.lastSynced,
          rev: base.rev,
          size: 0,
          deleted: false,
        });
      }
    }

    for (const entry of deltaEntries) {
      if (entry.deleted) {
        fullRemoteMap.delete(entry.pathLower);
      } else {
        fullRemoteMap.set(entry.pathLower, entry);
      }
    }

    // 제외 패턴 + conflict 파일 제외
    const excludePatterns = this.options.excludePatterns ?? [];
    for (const key of fullRemoteMap.keys()) {
      if (isExcluded(key, excludePatterns.map((p) => p.toLowerCase())) || isConflictFile(key)) {
        fullRemoteMap.delete(key);
      }
    }

    return fullRemoteMap;
  }

  /** base에 있지만 로컬에 없는 파일 → 삭제 의도 보완 (vault 이벤트 누락 안전망) */
  private inferMissingDeletes(
    localFiles: import("../types").FileInfo[],
    fullRemoteMap: Map<string, RemoteEntry>,
    baseEntries: import("../types").SyncEntry[],
  ): void {
    const localPathSet = new Set(localFiles.map((f) => f.pathLower));
    for (const base of baseEntries) {
      if (
        !localPathSet.has(base.pathLower) &&
        !this.deletedPaths.has(base.pathLower) &&
        fullRemoteMap.has(base.pathLower)
      ) {
        this.deletedPaths.add(base.pathLower);
      }
    }
  }

  /** 삭제 가드 적용 → 실행할 plan과 스킵 수 반환 */
  private async applyDeleteGuard(
    plan: SyncPlan,
    ctx?: CycleContext,
  ): Promise<{ planToExecute: SyncPlan; deletesSkipped: number }> {
    const threshold = this.options.deleteThreshold ?? 5;
    const guard = checkDeleteGuard(
      plan,
      threshold,
      this.options.deleteProtection ?? false,
    );

    ctx?.emit({
      type: "delete_guard",
      ts: Date.now(),
      deleteCount: guard.deleteItems.length,
      threshold,
      passed: guard.passed,
    });

    if (guard.passed) {
      return { planToExecute: plan, deletesSkipped: 0 };
    }

    if (this.options.onDeleteGuardTriggered) {
      const approved = await this.options.onDeleteGuardTriggered(guard);
      if (approved) {
        return { planToExecute: plan, deletesSkipped: 0 };
      }
    }

    return { planToExecute: guard.filteredPlan, deletesSkipped: guard.deleteItems.length };
  }

  /** cursor 갱신 + 성공한 삭제 항목 정리 */
  private async finalizeState(
    store: import("../adapters/interfaces").SyncStateStore,
    result: SyncResult,
    latestCursor: string,
    deletesSkipped: number,
  ): Promise<void> {
    // 모두 성공 시에만 cursor 갱신 (deferred도 미완료 취급)
    if (result.failed.length === 0 && deletesSkipped === 0 && result.deferred.length === 0) {
      await store.setMeta("cursor", latestCursor);
    }

    // 성공한 삭제 항목을 deletedPaths에서 제거
    for (const item of result.succeeded) {
      if (item.action.type === "deleteRemote" || item.action.type === "deleteLocal") {
        this.deletedPaths.delete(item.pathLower);
      }
    }
  }
}
