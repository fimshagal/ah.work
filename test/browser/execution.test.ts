import { describe, it, expect, afterEach } from "vitest";
import {
  createRuntime,
  AbortError,
  TaskTimeoutError,
  WorkerCrashedError,
  WorkerSpawnError,
  RuntimeShutdownError,
  RuntimeError,
  QueueFullError,
} from "../../src";
import type { Runtime } from "../../src";

/**
 * These tests need a real browser Worker (blob URL + postMessage).
 * jsdom cannot do that — that is why they live here, not in test/*.test.ts.
 */

const runtimes: Runtime[] = [];

function runtime(
  options?: Parameters<typeof createRuntime>[0],
): Runtime {
  const instance = createRuntime(options);
  runtimes.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.shutdown()));
});

describe("AhWork in a real browser worker", () => {
  it("executes a single task", async () => {
    const r = runtime({ maxWorkers: 2 });
    const square = r.task((n: number) => n * n);
    expect(await square(12)).toBe(144);
  });

  it("accepts multiple arguments and returns an object", async () => {
    const r = runtime();
    const summarize = r.task((a: number, b: number) => ({ sum: a + b }));
    expect(await summarize(10, 20)).toEqual({ sum: 30 });
  });

  it("awaits async tasks", async () => {
    const r = runtime();
    const slow = r.task(async (n: number) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return n * 2;
    });
    expect(await slow(21)).toBe(42);
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

  it("injects context as the last argument", async () => {
    const r = runtime();
    const scale = r.task(
      (x: number, ctx: { multiplier: number }) => x * ctx.multiplier,
      { context: { multiplier: 10 } },
    );
    expect(await scale(5)).toBe(50);
  });

  it("runs map in parallel and keeps input order", async () => {
    const r = runtime({ maxWorkers: 4 });
    const square = r.task((n: number) => n * n);
    expect(await square.map([1, 2, 3, 4, 5])).toEqual([1, 4, 9, 16, 25]);

    const add = r.task((a: number, b: number) => a + b);
    expect(
      await add.map([
        [1, 2],
        [10, 20],
        [100, 200],
      ]),
    ).toEqual([3, 30, 300]);
  });

  it("reuses workers and does not exceed maxWorkers", async () => {
    const r = runtime({ maxWorkers: 2, idleTimeout: 0 });
    const ping = r.task((n: number) => n);
    await Promise.all([1, 2, 3, 4, 5, 6].map((n) => ping(n)));
    expect(r.stats().workers).toBeLessThanOrEqual(2);
    expect(r.stats().completedJobs).toBe(6);
  });

  it("prewarms minWorkers", () => {
    const r = runtime({ minWorkers: 2, maxWorkers: 4 });
    expect(r.stats().workers).toBe(2);
  });

  it("times out a blocking job", async () => {
    const r = runtime({ maxWorkers: 1 });
    const slow = r.task((ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        /* block */
      }
      return "done";
    });
    await expect(slow.run([5000], { timeout: 200 })).rejects.toBeInstanceOf(
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

  it("rejects a queued job on abort and leaves the running one alone", async () => {
    const r = runtime({ maxWorkers: 1 });
    const hold = r.task(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return "ok";
    });
    const first = hold();
    const controller = new AbortController();
    const queued = hold.run([], { signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toBeInstanceOf(AbortError);
    expect(await first).toBe("ok");
  });

  it("recovers from a worker crash and keeps processing", async () => {
    const r = runtime({ maxWorkers: 2, minWorkers: 1 });
    const fatal = r.task(() => {
      return new Promise<never>(() => {
        setTimeout(() => {
          throw new Error("fatal worker crash");
        }, 10);
      });
    });
    const ping = r.task((n: number) => n);
    await expect(fatal()).rejects.toBeInstanceOf(WorkerCrashedError);
    expect(await ping(7)).toBe(7);
    expect(r.stats().workers).toBeGreaterThanOrEqual(1);
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

  it("rejects queued jobs on graceful shutdown without waiting for them", async () => {
    const r = runtime({ maxWorkers: 1 });
    const slow = r.task(async (ms: number) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });
    const running = slow(80);
    const queued = slow(80);
    const shutting = r.shutdown({ graceful: true });
    await expect(queued).rejects.toBeInstanceOf(RuntimeShutdownError);
    expect(await running).toBe(80);
    await shutting;
  });

  it("force-terminates running jobs when graceful shutdown times out (P2 #7)", async () => {
    const r = runtime({ maxWorkers: 1 });
    // A tight CPU loop cannot observe aborts cooperatively, so only the
    // graceful timeout can end it.
    const block = r.task((ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        /* block */
      }
      return "done";
    });
    const pending = block.run([5000]);
    const shutting = r.shutdown({ graceful: true, timeout: 100 });
    await expect(pending).rejects.toBeInstanceOf(RuntimeShutdownError);
    await shutting;
  });

  it("escalates a pending graceful shutdown to immediate (Round 2 #3)", async () => {
    const r = runtime({ maxWorkers: 1 });
    // A tight loop that graceful shutdown alone would wait on indefinitely.
    const block = r.task((ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        /* block */
      }
      return "done";
    });
    const pending = block.run([5000]);
    const graceful = r.shutdown({ graceful: true });
    await r.shutdown(); // escalate: force-reject the running job now
    await expect(pending).rejects.toBeInstanceOf(RuntimeShutdownError);
    await graceful;
  });

  it("applies backpressure with maxQueue (P2 #6)", async () => {
    const r = runtime({ maxWorkers: 1, maxQueue: 1 });
    const hold = r.task(async (ms: number) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });
    const running = hold(100); // occupies the single worker
    const queued = hold(100); // fills the queue (size 1)
    await expect(hold(100)).rejects.toBeInstanceOf(QueueFullError); // over cap
    expect(await running).toBe(100);
    expect(await queued).toBe(100);
  });

  it("frees a task via dispose() and rejects further calls (P2 #5)", async () => {
    const r = runtime();
    const inc = r.task((n: number) => n + 1);
    expect(await inc(1)).toBe(2);
    inc.dispose();
    await expect(inc(1)).rejects.toBeInstanceOf(RuntimeError);
  });

  it("surfaces WorkerSpawnError when worker creation is blocked (CSP simulation, P1 #2)", async () => {
    const OriginalWorker = globalThis.Worker;
    // Emulate a strict CSP where constructing a blob: worker throws.
    globalThis.Worker = class {
      constructor() {
        throw new DOMException("blocked by Content-Security-Policy", "SecurityError");
      }
    } as unknown as typeof Worker;
    try {
      const r = createRuntime({ maxWorkers: 1 });
      const t = r.task((n: number) => n);
      await expect(t(1)).rejects.toBeInstanceOf(WorkerSpawnError);
      await r.shutdown();
    } finally {
      globalThis.Worker = OriginalWorker;
    }
  });

  it("recovers under load with interleaved crashes (P1/P6 stress)", async () => {
    const r = runtime({ maxWorkers: 4, minWorkers: 1 });
    const dbl = r.task((n: number) => n * 2);
    const crash = r.task(
      () =>
        new Promise<never>(() => {
          setTimeout(() => {
            throw new Error("induced crash");
          }, 5);
        }),
    );

    const results = await Promise.all([
      ...Array.from({ length: 24 }, (_, i) => dbl(i)),
      ...Array.from({ length: 6 }, () => crash().catch((e: unknown) => e)),
    ]);

    const okResults = results.slice(0, 24) as number[];
    expect(okResults).toEqual(Array.from({ length: 24 }, (_, i) => i * 2));

    const crashResults = results.slice(24);
    expect(crashResults).toHaveLength(6);
    for (const e of crashResults) {
      expect(e).toBeInstanceOf(WorkerCrashedError);
    }

    // The runtime is still healthy after the crash storm.
    expect(await dbl(21)).toBe(42);
    expect(r.stats().workers).toBeGreaterThanOrEqual(1);
  });
});
