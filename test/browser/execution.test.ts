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
  workerSourceCode,
} from "../../src";
import type { Runtime } from "../../src";

/**
 * These tests need a real browser Worker (blob URL + postMessage).
 * jsdom cannot do that — that is why they live here, not in test/*.test.ts.
 */

// These identifiers are resolved *inside the worker* (provided via `inject`) or
// are intentionally absent; declared here only so the task source type-checks.
declare const square: (x: number) => number;
declare const dbl: (x: number) => number;
declare const total: (x: number) => number;
declare const mul: (x: number, f: number) => number;
declare const missing: unknown;

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

  it("runs higher-priority queued jobs first (round 8)", async () => {
    const r = runtime({ maxWorkers: 1 });
    const order: string[] = [];
    const work = r.task(async (tag: string) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return tag;
    });

    // The first call takes the only worker synchronously, so the rest queue.
    const jobs = [
      work.run(["blocker"]),
      work.run(["low"], { priority: 0 }),
      work.run(["high"], { priority: 10 }),
    ].map((p) => p.then((tag) => order.push(tag)));

    await Promise.all(jobs);
    expect(order).toEqual(["blocker", "high", "low"]);
  });

  it("evicts the weakest queued job for a higher-priority one (round 8)", async () => {
    const r = runtime({
      maxWorkers: 1,
      maxQueue: 1,
      onQueueFull: "evict-lowest",
    });
    const work = r.task(async (tag: string) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return tag;
    });

    const blocker = work.run(["blocker"]);
    const low = work.run(["low"], { priority: 0 });
    const high = work.run(["high"], { priority: 10 });

    await expect(low).rejects.toBeInstanceOf(QueueFullError);
    expect(await blocker).toBe("blocker");
    expect(await high).toBe("high");
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

describe("AhWork round 3 features", () => {
  it("runs via a hosted workerUrl backend (CSP escape hatch)", async () => {
    // Emulate a hosted worker file by serving the exported source from a URL.
    const url = URL.createObjectURL(
      new Blob([workerSourceCode], { type: "text/javascript" }),
    );
    try {
      const r = runtime({ maxWorkers: 2, workerUrl: url });
      const square = r.task((n: number) => n * n);
      expect(await square(9)).toBe(81);
      expect(await square.map([2, 3, 4])).toEqual([4, 9, 16]);
    } finally {
      URL.revokeObjectURL(url);
    }
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
    expect(buffer.byteLength).toBe(0); // detached => it was transferred, not copied
  });

  it("does not transfer when autoTransfer is off (buffer stays intact)", async () => {
    const r = runtime(); // autoTransfer defaults to false
    const len = r.task((buf: ArrayBuffer) => buf.byteLength);
    const buffer = new Uint8Array([9, 9, 9]).buffer;
    expect(await len(buffer)).toBe(3);
    expect(buffer.byteLength).toBe(3); // copied, source intact
  });

  it("retries transient worker spawn failures and eventually succeeds", async () => {
    const RealWorker = globalThis.Worker;
    let failuresLeft = 2;
    globalThis.Worker = class {
      constructor(url: string | URL) {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new DOMException("transient CSP", "SecurityError");
        }
        // Returning an object from a constructor replaces the instance.
        return new RealWorker(url);
      }
    } as unknown as typeof Worker;
    try {
      const r = createRuntime({ maxWorkers: 1, retries: 3 });
      const t = r.task((n: number) => n * 2);
      expect(await t(21)).toBe(42);
      expect(failuresLeft).toBe(0); // both transient failures were consumed
      await r.shutdown();
    } finally {
      globalThis.Worker = RealWorker;
    }
  });

  it("gives up after exhausting retries", async () => {
    const RealWorker = globalThis.Worker;
    globalThis.Worker = class {
      constructor() {
        throw new DOMException("always blocked", "SecurityError");
      }
    } as unknown as typeof Worker;
    try {
      const r = createRuntime({ maxWorkers: 1, retries: 2 });
      const t = r.task((n: number) => n);
      await expect(t(1)).rejects.toBeInstanceOf(WorkerSpawnError);
      await r.shutdown();
    } finally {
      globalThis.Worker = RealWorker;
    }
  });

  it("calls an injected helper function from inside the task", async () => {
    const r = runtime();
    const t = r.task((n: number) => square(n) + 1, {
      inject: { square: (x: number) => x * x },
    });
    expect(await t(5)).toBe(26); // 25 + 1
  });

  it("supports helpers that call one another", async () => {
    const r = runtime();
    const t = r.task((n: number) => total(n), {
      inject: {
        dbl: (x: number) => x * 2,
        total: (x: number) => dbl(x) + dbl(x), // helper calling another helper
      },
    });
    expect(await t(10)).toBe(40);
  });

  it("combines inject helpers with a context argument", async () => {
    const r = runtime();
    const t = r.task(
      (n: number, ctx: { factor: number }) => mul(n, ctx.factor),
      {
        context: { factor: 3 },
        inject: { mul: (x: number, f: number) => x * f },
      },
    );
    expect(await t(7)).toBe(21);
  });

  it("surfaces a helpful error when a non-injected helper is missing", async () => {
    const r = runtime();
    // `missing` is never injected -> ReferenceError inside the worker.
    const t = r.task((n: number) => (missing as (x: number) => number)(n));
    await expect(t(1)).rejects.toMatchObject({ name: "ReferenceError" });
  });

  it("never retries ordinary task errors", async () => {
    const r = runtime({ retries: 5 });
    // A RangeError is a task (application) error, not an infrastructure failure,
    // so it is surfaced immediately and the task still works afterwards.
    const boom = r.task((n: number) => {
      if (n < 0) throw new RangeError("negative");
      return n;
    });
    await expect(boom(-1)).rejects.toMatchObject({ name: "RangeError" });
    expect(await boom(7)).toBe(7);
  });
});
