import { createRuntime, workerSourceCode } from "../../src/index";
import type { Example } from "./types";

// Resolved inside the worker via `inject` (see the "inject" example); declared
// here only so the task source type-checks.
declare const isPrime: (n: number) => boolean;

export const examples: Example[] = [
  {
    id: "single-task",
    title: "1. Single task (Collatz)",
    description:
      "Move a CPU-bound function off the main thread. Call the task like a normal async function.",
    code: `const runtime = createRuntime({ maxWorkers: 4 });

const collatz = runtime.task((start: number) => {
  let n = start;
  let steps = 0;
  while (n !== 1) {
    n = n % 2 === 0 ? n / 2 : n * 3 + 1;
    steps++;
  }
  return steps;
});

const result = await collatz(27);
console.log(result); // 111

await runtime.shutdown();`,
    run: async (log) => {
      const runtime = createRuntime({ maxWorkers: 4 });
      const collatz = runtime.task((start: number) => {
        let n = start;
        let steps = 0;
        while (n !== 1) {
          n = n % 2 === 0 ? n / 2 : n * 3 + 1;
          steps++;
        }
        return steps;
      });
      const result = await collatz(27);
      log(`collatz(27) = ${result}`);
      await runtime.shutdown();
      log("runtime shut down");
    },
  },
  {
    id: "multiple-args",
    title: "2. Multiple arguments",
    description: "Tasks accept multiple arguments and TypeScript infers them.",
    code: `const runtime = createRuntime();

const add = runtime.task((a: number, b: number) => a + b);

console.log(await add(10, 20)); // 30

await runtime.shutdown();`,
    run: async (log) => {
      const runtime = createRuntime();
      const add = runtime.task((a: number, b: number) => a + b);
      log(`add(10, 20) = ${await add(10, 20)}`);
      await runtime.shutdown();
    },
  },
  {
    id: "async-task",
    title: "3. Async task",
    description:
      "Async task functions work too. The runtime awaits the returned promise inside the worker.",
    code: `const runtime = createRuntime();

const slowDouble = runtime.task(async (n: number) => {
  await new Promise((r) => setTimeout(r, 100));
  return n * 2;
});

console.log(await slowDouble(21)); // 42

await runtime.shutdown();`,
    run: async (log) => {
      const runtime = createRuntime();
      const slowDouble = runtime.task(async (n: number) => {
        await new Promise((r) => setTimeout(r, 100));
        return n * 2;
      });
      log(`slowDouble(21) = ${await slowDouble(21)}`);
      await runtime.shutdown();
    },
  },
  {
    id: "object-io",
    title: "4. Object arguments and return values",
    description:
      "Arguments and results are passed via structured clone, so plain objects work.",
    code: `const runtime = createRuntime();

const stats = runtime.task((nums: number[]) => ({
  sum: nums.reduce((a, b) => a + b, 0),
  max: Math.max(...nums),
  count: nums.length,
}));

console.log(await stats([3, 1, 4, 1, 5, 9, 2, 6]));

await runtime.shutdown();`,
    run: async (log) => {
      const runtime = createRuntime();
      const stats = runtime.task((nums: number[]) => ({
        sum: nums.reduce((a, b) => a + b, 0),
        max: Math.max(...nums),
        count: nums.length,
      }));
      log(await stats([3, 1, 4, 1, 5, 9, 2, 6]));
      await runtime.shutdown();
    },
  },
  {
    id: "concurrent",
    title: "5. Concurrent jobs, worker reuse & stats",
    description:
      "Submitting many jobs spins up workers on demand (up to maxWorkers), reuses them, and runtime.stats() reports activity.",
    code: `const runtime = createRuntime({ maxWorkers: 4 });

const collatz = runtime.task((start: number) => {
  let n = start;
  let steps = 0;
  while (n !== 1) {
    n = n % 2 === 0 ? n / 2 : n * 3 + 1;
    steps++;
  }
  return steps;
});

const inputs = [27, 97, 871, 6171, 77031, 837799, 626331, 8400511];
const results = await Promise.all(inputs.map((n) => collatz(n)));
console.log(results);
console.log(runtime.stats());

await runtime.shutdown();`,
    run: async (log) => {
      const runtime = createRuntime({ maxWorkers: 4 });
      const collatz = runtime.task((start: number) => {
        let n = start;
        let steps = 0;
        while (n !== 1) {
          n = n % 2 === 0 ? n / 2 : n * 3 + 1;
          steps++;
        }
        return steps;
      });
      const inputs = [27, 97, 871, 6171, 77031, 837799, 626331, 8400511];
      const results = await Promise.all(inputs.map((n) => collatz(n)));
      log(`results = [${results.join(", ")}]`);
      log(runtime.stats());
      await runtime.shutdown();
    },
  },
  {
    id: "errors",
    title: "6. Error propagation",
    description:
      "Errors thrown inside a task are serialized and rejected on the main thread. The runtime keeps working.",
    code: `const runtime = createRuntime();

const boom = runtime.task((x: number) => {
  if (x < 0) throw new RangeError("x must be >= 0");
  return Math.sqrt(x);
});

try {
  await boom(-1);
} catch (err) {
  console.log((err as Error).name, (err as Error).message);
}

console.log(await boom(144)); // 12 — runtime still usable

await runtime.shutdown();`,
    run: async (log) => {
      const runtime = createRuntime();
      const boom = runtime.task((x: number) => {
        if (x < 0) throw new RangeError("x must be >= 0");
        return Math.sqrt(x);
      });
      try {
        await boom(-1);
      } catch (err) {
        log(`caught: ${(err as Error).name}: ${(err as Error).message}`);
      }
      log(`boom(144) = ${await boom(144)} (runtime still usable)`);
      await runtime.shutdown();
    },
  },
  {
    id: "autoscaling",
    title: "7. Auto-scaling (minWorkers & idleTimeout)",
    description:
      "With minWorkers=1 the pool prewarms 1 worker. A burst scales it up to maxWorkers; after idleTimeout the idle workers are terminated back down to minWorkers.",
    code: `const runtime = createRuntime({
  minWorkers: 1,
  maxWorkers: 4,
  idleTimeout: 1500,
});

const collatz = runtime.task((start: number) => {
  let n = start, steps = 0;
  while (n !== 1) { n = n % 2 === 0 ? n / 2 : n * 3 + 1; steps++; }
  return steps;
});

console.log("prewarmed:", runtime.stats().workers); // 1

await Promise.all([27, 97, 871, 6171, 77031, 837799, 626331, 8400511]
  .map((n) => collatz(n)));
console.log("after burst:", runtime.stats().workers); // up to 4

await new Promise((r) => setTimeout(r, 2000)); // wait past idleTimeout
console.log("after idle:", runtime.stats().workers); // back to 1 (minWorkers)

await runtime.shutdown();`,
    run: async (log) => {
      const runtime = createRuntime({
        minWorkers: 1,
        maxWorkers: 4,
        idleTimeout: 1500,
      });
      const collatz = runtime.task((start: number) => {
        let n = start;
        let steps = 0;
        while (n !== 1) {
          n = n % 2 === 0 ? n / 2 : n * 3 + 1;
          steps++;
        }
        return steps;
      });
      log(`prewarmed workers = ${runtime.stats().workers}`);
      await Promise.all(
        [27, 97, 871, 6171, 77031, 837799, 626331, 8400511].map((n) =>
          collatz(n),
        ),
      );
      log(`after burst = ${runtime.stats().workers} worker(s)`);
      log("waiting 2s for idle timeout...");
      await new Promise((r) => setTimeout(r, 2000));
      log(`after idle = ${runtime.stats().workers} worker(s) (minWorkers)`);
      await runtime.shutdown();
    },
  },
  {
    id: "closure-limitation",
    title: "8. Closure limitation (fn.toString caveat)",
    description:
      "Serialization uses fn.toString(), so external/closure variables do NOT exist in the worker. This example intentionally fails to show the meaningful error.",
    code: `const runtime = createRuntime();

const multiplier = 10; // closure variable — NOT available in the worker
const scale = runtime.task((x: number) => x * multiplier);

try {
  await scale(5);
} catch (err) {
  console.log((err as Error).name, (err as Error).message);
}

await runtime.shutdown();`,
    run: async (log) => {
      const runtime = createRuntime();
      const multiplier = 10;
      const scale = runtime.task((x: number) => x * multiplier);
      try {
        const value = await scale(5);
        log(`unexpectedly succeeded: ${value}`);
      } catch (err) {
        log(`caught (expected): ${(err as Error).name}: ${(err as Error).message}`);
      }
      await runtime.shutdown();
    },
  },
  {
    id: "context",
    title: "9. Passing external data via context (closure fix)",
    description:
      "The supported way to pass external/closure values: provide a serializable `context`. It is injected as the task's last argument (you still call the task with the normal args only).",
    code: `const runtime = createRuntime();

const multiplier = 10; // external value

const scale = runtime.task(
  (x: number, ctx: { multiplier: number }) => x * ctx.multiplier,
  { context: { multiplier } }, // serialized once, cached on the worker
);

console.log(await scale(5)); // 50 — called with args only

await runtime.shutdown();`,
    run: async (log) => {
      const runtime = createRuntime();
      const multiplier = 10;
      const scale = runtime.task(
        (x: number, ctx: { multiplier: number }) => x * ctx.multiplier,
        { context: { multiplier } },
      );
      log(`scale(5) = ${await scale(5)} (context injected)`);
      log(`scale(8) = ${await scale(8)}`);
      await runtime.shutdown();
    },
  },
  {
    id: "map",
    title: "10. Parallel map (ordered results)",
    description:
      "task.map() runs many inputs in parallel across the pool; results always match input order. Single-arg tasks take a value list, multi-arg tasks take tuples.",
    code: `const runtime = createRuntime({ maxWorkers: 4 });

const square = runtime.task((n: number) => n * n);
console.log(await square.map([1, 2, 3, 4, 5])); // [1, 4, 9, 16, 25]

const add = runtime.task((a: number, b: number) => a + b);
console.log(await add.map([[1, 2], [10, 20], [100, 200]])); // [3, 30, 300]

await runtime.shutdown();`,
    run: async (log) => {
      const runtime = createRuntime({ maxWorkers: 4 });
      const square = runtime.task((n: number) => n * n);
      log(`square.map([1..5]) = [${(await square.map([1, 2, 3, 4, 5])).join(", ")}]`);
      const add = runtime.task((a: number, b: number) => a + b);
      const sums = await add.map([
        [1, 2],
        [10, 20],
        [100, 200],
      ]);
      log(`add.map(tuples) = [${sums.join(", ")}]`);
      await runtime.shutdown();
    },
  },
  {
    id: "timeout",
    title: "11. Timeout",
    description:
      "A per-job timeout rejects with TaskTimeoutError and terminates the (uncooperative, CPU-blocking) worker. A replacement is spawned on demand.",
    code: `const runtime = createRuntime();

const slow = runtime.task((ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {} // blocks the worker thread
  return "done";
});

try {
  await slow.run([5000], { timeout: 500 });
} catch (err) {
  console.log((err as Error).name); // TaskTimeoutError
}

await runtime.shutdown();`,
    run: async (log) => {
      const runtime = createRuntime();
      const slow = runtime.task((ms: number) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          /* block */
        }
        return "done";
      });
      try {
        await slow.run([5000], { timeout: 500 });
        log("unexpectedly finished");
      } catch (err) {
        log(`caught: ${(err as Error).name}: ${(err as Error).message}`);
      }
      await runtime.shutdown();
    },
  },
  {
    id: "abort",
    title: "12. Cancellation (AbortSignal)",
    description:
      "Cancel a running job with a standard AbortSignal. A queued job would be dropped; a running one terminates its worker. The job rejects with AbortError.",
    code: `const runtime = createRuntime();

const heavy = runtime.task((n: number) => {
  let x = 0;
  for (let i = 0; i < n; i++) x += Math.sqrt(i);
  return x;
});

const controller = new AbortController();
const promise = heavy.run([5_000_000_000], { signal: controller.signal });
setTimeout(() => controller.abort(), 200);

try {
  await promise;
} catch (err) {
  console.log((err as Error).name); // AbortError
}

await runtime.shutdown();`,
    run: async (log) => {
      const runtime = createRuntime();
      const heavy = runtime.task((n: number) => {
        let x = 0;
        for (let i = 0; i < n; i++) x += Math.sqrt(i);
        return x;
      });
      const controller = new AbortController();
      const promise = heavy.run([5_000_000_000], {
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 200);
      try {
        await promise;
        log("unexpectedly finished");
      } catch (err) {
        log(`caught: ${(err as Error).name}: ${(err as Error).message}`);
      }
      await runtime.shutdown();
    },
  },
  {
    id: "backpressure",
    title: "13. Backpressure (maxQueue)",
    description:
      "maxQueue bounds the waiting queue. When the pool is saturated and the queue is full, extra submissions reject immediately with QueueFullError instead of growing memory unbounded.",
    code: `const runtime = createRuntime({ maxWorkers: 1, maxQueue: 1 });

const hold = runtime.task(async (ms: number) => {
  await new Promise((r) => setTimeout(r, ms));
  return ms;
});

const running = hold(100); // occupies the single worker
const queued = hold(100);  // fills the queue (size 1)

try {
  await hold(100);         // over capacity
} catch (err) {
  console.log((err as Error).name); // QueueFullError
}

console.log(await running, await queued); // 100 100

await runtime.shutdown();`,
    run: async (log) => {
      const runtime = createRuntime({ maxWorkers: 1, maxQueue: 1 });
      const hold = runtime.task(async (ms: number) => {
        await new Promise((r) => setTimeout(r, ms));
        return ms;
      });
      const running = hold(100);
      const queued = hold(100);
      try {
        await hold(100);
        log("unexpectedly accepted");
      } catch (err) {
        log(`3rd submit rejected: ${(err as Error).name}`);
      }
      log(`running = ${await running}, queued = ${await queued}`);
      await runtime.shutdown();
    },
  },
  {
    id: "dispose",
    title: "14. Disposing a task",
    description:
      "task.dispose() frees the task's serialized source and cached context from the runtime and every worker. Calling it afterwards rejects with RuntimeError.",
    code: `const runtime = createRuntime();

const inc = runtime.task((n: number) => n + 1);
console.log(await inc(1)); // 2

inc.dispose();

try {
  await inc(1);
} catch (err) {
  console.log((err as Error).name); // RuntimeError
}

await runtime.shutdown();`,
    run: async (log) => {
      const runtime = createRuntime();
      const inc = runtime.task((n: number) => n + 1);
      log(`inc(1) = ${await inc(1)}`);
      inc.dispose();
      try {
        await inc(1);
        log("unexpectedly succeeded");
      } catch (err) {
        log(`after dispose: ${(err as Error).name}: ${(err as Error).message}`);
      }
      await runtime.shutdown();
    },
  },
  {
    id: "retries",
    title: "15. Retries on infrastructure failures",
    description:
      "retries re-runs a job only when a worker fails to spawn or crashes (never on task errors / timeout / abort). Here we simulate a flaky environment where creating a Worker throws the first two times.",
    code: `const runtime = createRuntime({ maxWorkers: 1, retries: 3 });

// Infrastructure failures (WorkerSpawnError / WorkerCrashedError) are retried;
// a transient failure recovers transparently.
const double = runtime.task((n: number) => n * 2);

console.log(await double(21)); // 42, after automatic retries

await runtime.shutdown();`,
    run: async (log) => {
      const RealWorker = globalThis.Worker;
      let failuresLeft = 2;
      // Simulate a flaky environment: first 2 Worker constructions throw.
      globalThis.Worker = class {
        constructor(url: string | URL) {
          if (failuresLeft > 0) {
            failuresLeft -= 1;
            throw new DOMException("transient failure", "SecurityError");
          }
          return new RealWorker(url);
        }
      } as unknown as typeof Worker;
      try {
        const runtime = createRuntime({ maxWorkers: 1, retries: 3 });
        const double = runtime.task((n: number) => n * 2);
        log("submitting with a flaky Worker constructor (2 failures)...");
        log(`double(21) = ${await double(21)} (recovered via retries)`);
        await runtime.shutdown();
      } finally {
        globalThis.Worker = RealWorker;
      }
    },
  },
  {
    id: "auto-transfer",
    title: "16. Zero-copy transfer (autoTransfer)",
    description:
      "With autoTransfer, ArrayBuffers (and typed-array buffers) in the arguments are moved into the worker zero-copy instead of being cloned. Transferring detaches the source on the main thread (its byteLength becomes 0).",
    code: `const runtime = createRuntime({ autoTransfer: true });

const sum = runtime.task((buf: ArrayBuffer) => {
  const arr = new Uint8Array(buf);
  let s = 0;
  for (const x of arr) s += x;
  return s;
});

const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
console.log(await sum(buffer));   // 10
console.log(buffer.byteLength);   // 0 — detached (moved, not copied)

await runtime.shutdown();`,
    run: async (log) => {
      const runtime = createRuntime({ autoTransfer: true });
      const sum = runtime.task((buf: ArrayBuffer) => {
        const arr = new Uint8Array(buf);
        let s = 0;
        for (const x of arr) s += x;
        return s;
      });
      const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
      log(`byteLength before = ${buffer.byteLength}`);
      log(`sum = ${await sum(buffer)}`);
      log(`byteLength after = ${buffer.byteLength} (0 = transferred, not copied)`);
      await runtime.shutdown();
    },
  },
  {
    id: "worker-url",
    title: "17. Hosted worker backend (workerUrl / CSP)",
    description:
      "Strict Content-Security-Policy can block blob: workers. Host the exported workerSourceCode as a .js file and pass its URL via workerUrl. Here we build that URL at runtime to show the backend working.",
    code: `import { createRuntime, workerSourceCode } from "ahwork";

// In production: host workerSourceCode as /ahwork.worker.js and use that path.
const workerUrl = URL.createObjectURL(
  new Blob([workerSourceCode], { type: "text/javascript" }),
);

const runtime = createRuntime({ maxWorkers: 2, workerUrl });

const square = runtime.task((n: number) => n * n);
console.log(await square.map([2, 3, 4])); // [4, 9, 16]

await runtime.shutdown();
URL.revokeObjectURL(workerUrl);`,
    run: async (log) => {
      const workerUrl = URL.createObjectURL(
        new Blob([workerSourceCode], { type: "text/javascript" }),
      );
      try {
        const runtime = createRuntime({ maxWorkers: 2, workerUrl });
        const square = runtime.task((n: number) => n * n);
        log("runtime using a hosted workerUrl backend (no blob: worker)...");
        log(`square.map([2,3,4]) = [${(await square.map([2, 3, 4])).join(", ")}]`);
        await runtime.shutdown();
      } finally {
        URL.revokeObjectURL(workerUrl);
      }
    },
  },
  {
    id: "inject",
    title: "18. Injected helper functions (inject)",
    description:
      "context carries data, but structured clone cannot carry functions. Use inject to share helper functions: each is serialized like the task and rebuilt in the worker, so the task can call it by name. Helpers may call one another.",
    code: `const runtime = createRuntime();

const classify = runtime.task(
  (n: number) => (isPrime(n) ? "prime" : "composite"),
  {
    inject: {
      // self-contained helpers; they may also call each other
      isPrime: (n: number) => {
        if (n < 2) return false;
        for (let i = 2; i * i <= n; i++) if (n % i === 0) return false;
        return true;
      },
    },
  },
);

console.log(await classify.map([7, 8, 13, 15])); // ["prime","composite","prime","composite"]

await runtime.shutdown();`,
    run: async (log) => {
      const runtime = createRuntime();
      const classify = runtime.task(
        // `isPrime` is provided via inject, not a real closure.
        (n: number) => (isPrime(n) ? "prime" : "composite"),
        {
          inject: {
            isPrime: (n: number) => {
              if (n < 2) return false;
              for (let i = 2; i * i <= n; i++) if (n % i === 0) return false;
              return true;
            },
          },
        },
      );
      const out = await classify.map([7, 8, 13, 15]);
      log(`classify.map([7,8,13,15]) = [${out.join(", ")}]`);
      await runtime.shutdown();
    },
  },
];

/** Home-page comparison: same CPU work on the main thread vs the worker pool. */
export const homePerfExample: Example = {
  id: "home-perf",
  title: "Main thread vs worker pool",
  description:
    "Four independent CPU chunks. On the main thread they run one after another and freeze the UI. AhWork runs them in parallel (up to maxWorkers) and reuses the pool. The first worker spawn has a cost; this run warms the pool first so the timed part is steady-state.",
  code: `function burn(n: number): number {
  let acc = 0;
  for (let i = 0; i < n; i++) acc += Math.sqrt(i);
  return acc;
}

const chunks = [12_000_000, 12_000_000, 12_000_000, 12_000_000];

// Sequential — blocks the UI
const t0 = performance.now();
chunks.map(burn);
console.log("main thread", performance.now() - t0, "ms");

// Parallel — pool of 4, reuse after warmup
const runtime = createRuntime({ maxWorkers: 4 });
const task = runtime.task((n: number) => {
  let acc = 0;
  for (let i = 0; i < n; i++) acc += Math.sqrt(i);
  return acc;
});
await task.map([1, 1, 1, 1]); // warmup (spawn + register)

const t1 = performance.now();
await task.map(chunks);
console.log("AhWork", performance.now() - t1, "ms", runtime.stats());

await runtime.shutdown();`,
  run: async (log) => {
    const chunks = [12_000_000, 12_000_000, 12_000_000, 12_000_000];
    const burn = (n: number): number => {
      let acc = 0;
      for (let i = 0; i < n; i++) acc += Math.sqrt(i);
      return acc;
    };

    log("main thread: 4 chunks in sequence (UI may freeze)...");
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    const t0 = performance.now();
    chunks.forEach(burn);
    const mainMs = performance.now() - t0;
    log(`main thread: ${mainMs.toFixed(1)} ms`);

    const runtime = createRuntime({ maxWorkers: 4 });
    const task = runtime.task((n: number) => {
      let acc = 0;
      for (let i = 0; i < n; i++) acc += Math.sqrt(i);
      return acc;
    });

    log("warming 4 workers...");
    await task.map([1, 1, 1, 1]);

    log("AhWork: same 4 chunks in parallel...");
    const t1 = performance.now();
    await task.map(chunks);
    const workMs = performance.now() - t1;
    const stats = runtime.stats();
    log(`AhWork: ${workMs.toFixed(1)} ms  (${stats.workers} workers)`);
    log(
      `speedup: ${(mainMs / workMs).toFixed(2)}×  (not 4× — spawn is already paid, but scheduling + messaging still cost)`,
    );
    await runtime.shutdown();
  },
};

/** Tiny home-page demo: one task, one call. */
export const homeExample: Example = {
  id: "home-square",
  title: "Try it",
  description:
    "A single CPU-style function, moved off the main thread. Press Run.",
  code: `const runtime = createRuntime();

const square = runtime.task((n: number) => n * n);

console.log(await square(12)); // 144

await runtime.shutdown();`,
  run: async (log) => {
    const runtime = createRuntime();
    const square = runtime.task((n: number) => n * n);
    log(`square(12) = ${await square(12)}`);
    await runtime.shutdown();
  },
};
