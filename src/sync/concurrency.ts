/**
 * 동시성 제한 worker pool.
 * 외부 의존 없이 Promise 기반으로 최대 N개 태스크를 병렬 실행한다.
 */

export interface ConcurrencyOptions {
  /** 중단 시그널 */
  signal?: AbortSignal;
  /** 각 태스크 완료 시 호출 */
  onTaskComplete?: () => void;
}

export type SettledResult<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown };

/**
 * tasks 배열을 최대 concurrency개씩 병렬 실행한다.
 * 반환값은 입력 순서와 동일한 SettledResult 배열.
 */
export async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
  options?: ConcurrencyOptions,
): Promise<SettledResult<T>[]> {
  const results = new Array<SettledResult<T>>(tasks.length);
  let index = 0;

  async function worker(): Promise<void> {
    while (index < tasks.length) {
      if (options?.signal?.aborted) break;
      const i = index++;
      try {
        results[i] = { status: "fulfilled", value: await tasks[i]() };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
        if (options?.signal?.aborted) break;
      }
      options?.onTaskComplete?.();
    }
  }

  const workers: Promise<void>[] = [];
  const workerCount = Math.min(concurrency, tasks.length);
  for (let w = 0; w < workerCount; w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return results;
}
