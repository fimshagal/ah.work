import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRuntime,
  AbortError,
  TaskTimeoutError,
  WorkerCrashedError,
  RuntimeShutdownError,
  RuntimeError,
  QueueFullError,
  nodeWorkerPrelude,
  workerSourceCode,
} from "../../src/index.node";
import type { Runtime } from "../../src/index.node";

/**
 * The Node counterpart of test/browser/execution.test.ts: identical public API,
 * real `worker_threads` underneath instead of real Web Workers. Anything that
 * passes in both places is genuinely backend-independent.
 */

// Resolved inside the worker via `inject`; declared here only so the task
// source type-checks on the main side.
declare const square: (x: number) => number;
declare const dbl: (x: number) => number;
declare const total: (x: number) => number;

const runtimes: Runtime[] = [];

function runtime(options?: Parameters<typeof createRuntime>[0]): Runtime {
  const instance = createRuntime(options);
  runtimes.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.shutdown()));
});

describe("AhWork on node:worker_threads", () => {
  it("executes a single task", async () => {
    const r = runtime({ maxWorkers: 2 });
    const sq = r.task((n: number) => n * n);
    expect(await sq(12)).toBe(144);
  });

  it("awaits async tasks and returns objects", async () => {
    const r = runtime();
    const slow = r.task(async (a: number, b: number) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { sum: a + b };
    });
    expect(await slow(10, 20)).toEqual({ sum: 30 });
  });

  it("runs map in parallel and keeps input order", async () => {
    const r = runtime({ maxWorkers: 4 });
    const sq = r.task((n: number) => n * n);
    expect(await sq.map([1, 2, 3, 4, 5])).toEqual([1, 4, 9, 16, 25]);
  });

  it("reuses workers and does not exceed maxWorkers", async () => {
    const r = runtime({ maxWorkers: 2, idleTimeout: 0 });
    const ping = r.task((n: number) => n);
    await Promise.all([1, 2, 3, 4, 5, 6].map((n) => ping(n)));
    expect(r.stats().workers).toBeLessThanOrEqual(2);
    expect(r.stats().completedJobs).toBe(6);
  });

  it("injects context as the last argument", async () => {
    const r = runtime();
    const scale = r.task(
      (x: number, ctx: { multiplier: number }) => x * ctx.multiplier,
      { context: { multiplier: 10 } },
    );
    expect(await scale(5)).toBe(50);
  });

  it("calls injected helpers, including helpers calling helpers", async () => {
    const r = runtime();
    const one = r.task((n: number) => square(n) + 1, {
      inject: { square: (x: number) => x * x },
    });
    expect(await one(5)).toBe(26);

    const two = r.task((n: number) => total(n), {
      inject: {
        dbl: (x: number) => x * 2,
        total: (x: number) => dbl(x) + dbl(x),
      },
    });
    expect(await two(10)).toBe(40);
  });

  it("propagates thrown errors without killing the runtime", async () => {
    const r = runtime();
    const boom = r.task((x: number) => {
      if (x < 0) throw new RangeError("x must be >= 0");
      return Math.sqrt(x);
    });
    await expect(boom(-1)).rejects.toMatchObject({
      name: "RangeError",
      message: "x must be >= 0",
    });
    expect(await boom(144)).toBe(12);
  });

  it("hints when a closure variable is missing", async () => {
    const r = runtime();
    const multiplier = 10;
    const scale = r.task((x: number) => x * multiplier);
    await expect(scale(5)).rejects.toMatchObject({ name: "ReferenceError" });
    await expect(scale(5)).rejects.toThrow(/context/);
  });

  it("times out a blocking job", async () => {
    const r = runtime({ maxWorkers: 1 });
    const block = r.task((ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        /* block */
      }
      return "done";
    });
    await expect(block.run([5000], { timeout: 200 })).rejects.toBeInstanceOf(
      TaskTimeoutError,
    );
  });

  it("cancels a running job via AbortSignal", async () => {
    const r = runtime({ maxWorkers: 1 });
    const heavy = r.task((n: number) => {
      let acc = 0;
      for (let i = 0; i < n; i++) acc += i;
      return acc;
    });
    const controller = new AbortController();
    const promise = heavy.run([200_000_000], { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(promise).rejects.toBeInstanceOf(AbortError);
  });

  it("applies backpressure with maxQueue", async () => {
    const r = runtime({ maxWorkers: 1, maxQueue: 1 });
    const hold = r.task(async (ms: number) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });
    const running = hold(100);
    const queued = hold(100);
    await expect(hold(100)).rejects.toBeInstanceOf(QueueFullError);
    expect(await running).toBe(100);
    expect(await queued).toBe(100);
  });

  it("waits for the running job on graceful shutdown", async () => {
    const r = runtime({ maxWorkers: 1 });
    const slow = r.task(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return 99;
    });
    const pending = slow();
    const shutting = r.shutdown({ graceful: true });
    expect(await pending).toBe(99);
    await shutting;
    await expect(slow()).rejects.toBeInstanceOf(RuntimeShutdownError);
  });

  it("frees a task via dispose() and rejects further calls", async () => {
    const r = runtime();
    const inc = r.task((n: number) => n + 1);
    expect(await inc(1)).toBe(2);
    inc.dispose();
    await expect(inc(1)).rejects.toBeInstanceOf(RuntimeError);
  });

  it("auto-transfers ArrayBuffers zero-copy and detaches the source", async () => {
    const r = runtime({ autoTransfer: true });
    const sum = r.task((buf: ArrayBuffer) => {
      const arr = new Uint8Array(buf);
      let s = 0;
      for (const x of arr) s += x;
      return s;
    });
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
    expect(await sum(buffer)).toBe(10);
    expect(buffer.byteLength).toBe(0); // detached => transferred, not copied
  });

  it("recovers from an uncaught error in a worker", async () => {
    const r = runtime({ maxWorkers: 2, minWorkers: 1 });
    const fatal = r.task(
      () =>
        new Promise<never>(() => {
          setTimeout(() => {
            throw new Error("fatal worker crash");
          }, 10);
        }),
    );
    const ping = r.task((n: number) => n);
    await expect(fatal()).rejects.toBeInstanceOf(WorkerCrashedError);
    expect(await ping(7)).toBe(7);
  });

  it("reports a worker that exits without throwing as a crash", async () => {
    // Node-only: a thread that calls process.exit() emits `exit` and never an
    // `error`. In a browser the same job would simply hang forever.
    const r = runtime({ maxWorkers: 1 });
    const suicide = r.task(
      () =>
        new Promise<never>(() => {
          setTimeout(() => process.exit(3), 10);
        }),
    );
    const ping = r.task((n: number) => n);
    await expect(suicide()).rejects.toBeInstanceOf(WorkerCrashedError);
    expect(await ping(7)).toBe(7);
  });

  it("runs from a worker file via workerUrl", async () => {
    // The CSP escape hatch of the browser build is a plain file path here, and
    // a file-based worker needs the prelude the eval path adds automatically.
    const dir = mkdtempSync(join(tmpdir(), "ahwork-"));
    const file = join(dir, "worker.cjs");
    writeFileSync(file, nodeWorkerPrelude + workerSourceCode, "utf8");
    try {
      const r = runtime({ maxWorkers: 2, workerUrl: file });
      const sq = r.task((n: number) => n * n);
      expect(await sq(9)).toBe(81);
      expect(await sq.map([2, 3, 4])).toEqual([4, 9, 16]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
