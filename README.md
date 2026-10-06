# AhWork

A small, dependency-light TypeScript runtime that executes CPU-intensive
JavaScript/TypeScript tasks on a dynamically managed pool of Web Workers.

You think in terms of **tasks**, not Worker instances. AhWork creates workers on
demand, reuses them, correlates messages with promises, and shuts everything
down cleanly — you never call `new Worker`, `postMessage`, or `onmessage`.

> **Status:** Phases 1–6 are implemented: pool, `map`, timeouts, abort, `context`,
> stats, crash replacement, immediate and graceful shutdown. See [`plan.md`](./plan.md).
>
> **Not yet implemented:** automatic transferable detection, CSP/static worker
> backend, React demo (`demo/`).

## Requirements

Modern browsers with Web Worker support. The Blob-worker approach may be
restricted by a strict Content Security Policy — see [Limitations](#limitations).

## Install (local dev)

```bash
npm install
```

## Scripts

| Command             | What it does                                  |
| ------------------- | --------------------------------------------- |
| `npm run examples`  | Start the local docs site (Home / Examples / Tutorial / API) |
| `npm test`          | Unit tests in jsdom (no real Web Workers)     |
| `npm run test:browser` | Execution tests in Chromium via Playwright |
| `npm run test:all`  | Unit tests, then browser tests                |
| `npm run typecheck` | Type-check with `tsc --noEmit`                |
| `npm run build`     | Build the library (ESM + `.d.ts`)             |
| `npm run lint`      | Lint with ESLint                              |

`npm test` is fast and does **not** start Chrome. It checks types of the API,
the scheduler, timeouts/abort bookkeeping and fake workers. jsdom has no real
`Worker`, so it cannot run `fn.toString()` inside a blob worker.

`npm run test:browser` opens headless Chromium (Playwright) and runs the same
kind of work as the examples page: real workers, `map`, timeout, abort, crash,
graceful shutdown. First run may download Chromium (`npx playwright install chromium`).

## Quick start

```ts
import { createRuntime } from "ahwork";

const runtime = createRuntime();

const square = runtime.task((n: number) => n * n);

console.log(await square(12)); // 144

await runtime.shutdown();
```

---

## Running the local site

Four pages, served by Vite from `examples/`:

| Page | URL | What it is |
| --- | --- | --- |
| Home | `/` or `/index.html` | What AhWork is + one runnable hello-world |
| Examples | `/examples.html` | All runnable cards (code + **Run**) |
| Tutorial | `/tutorial.html` | Concepts and how to use the API |
| API | `/docs.html` | Dry class / method reference |

```bash
npm run examples
```

Vite prints a local URL (usually `http://localhost:5173`). Open that — you land
on Home. Use the top nav, or go directly:

```
http://localhost:5173/
http://localhost:5173/examples.html
http://localhost:5173/tutorial.html
http://localhost:5173/docs.html
```

On Examples (and the Home demo), press **Run**. Output shows under the card and
in the DevTools console. The site imports the library from `src/`, so edits
reload live.

---

## Examples

Each section describes what it demonstrates, followed by the code you can run.

### Example: Single task (Collatz)

Move a CPU-bound function off the main thread and await it like a normal async
function.

```ts
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
console.log(result); // 111

await runtime.shutdown();
```

### Example: Multiple arguments

Tasks accept multiple arguments; TypeScript infers input and output types.

```ts
const runtime = createRuntime();

const add = runtime.task((a: number, b: number) => a + b);

console.log(await add(10, 20)); // 30

await runtime.shutdown();
```

### Example: Async task

Async task functions work — the worker awaits the returned promise.

```ts
const runtime = createRuntime();

const slowDouble = runtime.task(async (n: number) => {
  await new Promise((r) => setTimeout(r, 100));
  return n * 2;
});

console.log(await slowDouble(21)); // 42

await runtime.shutdown();
```

### Example: Object arguments and return values

Arguments and results travel via structured clone, so plain objects work.

```ts
const runtime = createRuntime();

const summarize = runtime.task((nums: number[]) => ({
  sum: nums.reduce((a, b) => a + b, 0),
  max: Math.max(...nums),
  count: nums.length,
}));

console.log(await summarize([3, 1, 4, 1, 5, 9, 2, 6]));

await runtime.shutdown();
```

### Example: Concurrent jobs, worker reuse & stats

Many jobs spin up workers on demand (up to `maxWorkers`), reuse them, and
`runtime.stats()` reports activity.

```ts
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

console.log(results);
console.log(runtime.stats());

await runtime.shutdown();
```

### Example: Parallel map (ordered results)

`task.map()` runs many inputs in parallel across the pool; results always match
input order. Single-argument tasks take a value list; multi-argument tasks take
tuples.

```ts
const runtime = createRuntime({ maxWorkers: 4 });

const square = runtime.task((n: number) => n * n);
console.log(await square.map([1, 2, 3, 4, 5])); // [1, 4, 9, 16, 25]

const add = runtime.task((a: number, b: number) => a + b);
console.log(await add.map([[1, 2], [10, 20], [100, 200]])); // [3, 30, 300]

await runtime.shutdown();
```

### Example: Timeout

A per-job `timeout` rejects with `TaskTimeoutError` and terminates the worker
running the (uncooperative, CPU-blocking) task; a replacement is spawned on
demand. `taskTimeout` in `createRuntime` sets the default; per-job `timeout`
overrides it. The timeout is a deadline measured from submission.

```ts
const runtime = createRuntime();

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

await runtime.shutdown();
```

### Example: Cancellation (`AbortSignal`)

Cancel work with a standard `AbortSignal` via `task.run(args, { signal })`. A
still-queued job is dropped; a running job terminates its worker (MVP uses
worker termination — cooperative cancellation is a future extension). The job
rejects with `AbortError` (the original abort reason is kept in `cause`).

```ts
const runtime = createRuntime();

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

await runtime.shutdown();
```

### Example: Error propagation

Errors thrown inside a task are serialized and rejected on the main thread; the
runtime keeps working.

```ts
const runtime = createRuntime();

const boom = runtime.task((x: number) => {
  if (x < 0) throw new RangeError("x must be >= 0");
  return Math.sqrt(x);
});

try {
  await boom(-1);
} catch (err) {
  console.log((err as Error).name, (err as Error).message); // RangeError ...
}

console.log(await boom(144)); // 12 — runtime still usable

await runtime.shutdown();
```

### Example: Auto-scaling (`minWorkers` & `idleTimeout`)

`minWorkers` prewarms workers up front; a burst of work scales the pool up to
`maxWorkers`; after `idleTimeout` the idle workers are terminated back down to
`minWorkers` (busy workers are never terminated).

```ts
const runtime = createRuntime({ minWorkers: 1, maxWorkers: 4, idleTimeout: 1500 });

const collatz = runtime.task((start: number) => {
  let n = start, steps = 0;
  while (n !== 1) { n = n % 2 === 0 ? n / 2 : n * 3 + 1; steps++; }
  return steps;
});

console.log("prewarmed:", runtime.stats().workers); // 1

await Promise.all(
  [27, 97, 871, 6171, 77031, 837799, 626331, 8400511].map((n) => collatz(n)),
);
console.log("after burst:", runtime.stats().workers); // up to 4

await new Promise((r) => setTimeout(r, 2000)); // wait past idleTimeout
console.log("after idle:", runtime.stats().workers); // back to 1 (minWorkers)

await runtime.shutdown();
```

### Example: Closure limitation (`fn.toString()` caveat)

Serialization uses `fn.toString()`, so **external/closure variables do not exist
in the worker**. This intentionally fails to show the meaningful error.

```ts
const runtime = createRuntime();

const multiplier = 10; // closure variable — NOT available inside the worker
const scale = runtime.task((x: number) => x * multiplier);

try {
  await scale(5);
} catch (err) {
  console.log((err as Error).name, (err as Error).message); // ReferenceError ...
}

await runtime.shutdown();
```

### Example: Passing external data via `context` (closure fix)

The supported way to pass external/closure values into a task: provide a
serializable `context`. It is sent once, cached on the worker, and injected as
the task function's **last argument** — you still call the task with the normal
arguments only.

```ts
const runtime = createRuntime();

const multiplier = 10; // external value

const scale = runtime.task(
  (x: number, ctx: { multiplier: number }) => x * ctx.multiplier,
  { context: { multiplier } }, // serialized once, cached on the worker
);

console.log(await scale(5)); // 50 — called with args only

await runtime.shutdown();
```

The `context` must be structured-clone compatible (no functions, DOM nodes, or
class instances with methods). For captured **functions** or module imports, see
[`plan.md`](./plan.md) (`inject` / module-backend, later phases).

---

## Runtime configuration

```ts
createRuntime({
  minWorkers: 0,        // workers kept warm; prewarmed on creation. Default: 0
  maxWorkers: "auto",   // upper bound; "auto" = navigator.hardwareConcurrency || 4
  idleTimeout: 10_000,  // ms an idle worker lives before termination (0 = never)
  taskTimeout: 0,       // default per-task timeout (ms); 0 = no timeout (phase 5)
});
```

Multiple independent runtimes can coexist; there is no global singleton.

`await runtime.shutdown()` is immediate: queued and running jobs reject with
`RuntimeShutdownError`, workers die, the blob URL is revoked.
`await runtime.shutdown({ graceful: true })` still rejects jobs that have not
started, but waits for jobs that are already running.

## When are Web Workers useful?

Workers move **CPU-heavy** work off the main thread and let suitable workloads
run in parallel across cores. They do **not** make arbitrary asynchronous code
faster — I/O-bound or already-async work usually gains nothing, and there is
per-job serialization and worker-startup overhead. Reach for AhWork when you
have genuinely expensive synchronous computation that would otherwise block the
UI thread.

## Limitations

- **Closures aren't serialized.** `fn.toString()` captures only the function
  text. External variables, imports, and `this` do not exist in the worker. Pass
  external **data** explicitly via the `context` task option (see the example
  above); captured functions/module imports are a later phase.
- **Structured clone restrictions.** Arguments/results must be structured-clone
  compatible (no functions, DOM nodes, or class instances with methods).
- **CSP.** The dynamic `blob:` worker can be blocked by a strict Content
  Security Policy (`worker-src` / `script-src`). A static-worker backend is a
  planned extension point.
- **Security.** The worker reconstructs functions from source text. Never pass
  code assembled from untrusted/user input to `runtime.task(...)`.
- **Startup overhead & browser support.** First job pays worker startup cost;
  targets modern browsers.

## License

MIT
