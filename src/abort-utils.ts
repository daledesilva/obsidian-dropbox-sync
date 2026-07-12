/** AbortSignal이 있으면 즉시 throw. */
export function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

/** promise를 signal abort와 race — HTTP/대기 중단용. */
export function runAbortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/** setTimeout을 abort로 취소 가능하게. */
export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  await runAbortable(new Promise((resolve) => setTimeout(resolve, ms)), signal);
}
