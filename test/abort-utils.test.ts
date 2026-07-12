import { describe, test, expect } from "bun:test";
import { delay, runAbortable } from "@/abort-utils";

describe("abort-utils", () => {
  test("runAbortable: abort during in-flight promise", async () => {
    const controller = new AbortController();
    const slow = new Promise<string>((resolve) => {
      setTimeout(() => resolve("done"), 5000);
    });
    setTimeout(() => controller.abort(), 10);
    await expect(runAbortable(slow, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  test("delay: abort during backoff wait", async () => {
    const controller = new AbortController();
    const pending = delay(10_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
