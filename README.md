# AhWork

Run CPU-heavy JavaScript off the main thread without ever touching a `Worker`.

AhWork is a small, dependency-free TypeScript runtime that executes expensive
tasks on a pool of workers it manages for you — Web Workers in the browser,
`worker_threads` on Node, same API either way.

**The problem.** Raw Web Workers make you rebuild the same plumbing every time:
spawn a worker, invent a message protocol, match replies to requests, handle the
one that crashed, remember to terminate everything. None of that is the
computation you actually care about.

**What you do instead.** You register a function as a **task** and call it like
a normal async function. AhWork creates workers on demand, reuses them, matches
messages to promises, replaces crashed ones, and shuts the pool down cleanly —
you never call `new Worker`, `postMessage`, or `onmessage`.

> **Status:** Phases 1–6 and audit rounds 1–4 are in: the pool, `map`, timeouts,
> `AbortSignal`, `context`, `inject`, stats, crash replacement, immediate and
> graceful shutdown (with timeout + escalation), option validation, backpressure
> (`maxQueue`), per-job `retries`, automatic transferable detection
> (`autoTransfer`), a static-worker backend (`workerUrl`), `task.dispose()` and
> a Node `worker_threads` backend. See [`plan.md`](./plan.md).
>
> **Not yet:** a module backend for real `import`s inside workers, a build plugin
> for transparent closures, automatic `dist/ahwork.worker.js` emission, and the
> standalone React demo (`demo/`).

## Requirements

A modern browser with Web Worker support, or Node 18+. Nothing else — the
library has zero runtime dependencies.

## Backends

The same `createRuntime` runs on two different worker implementations. You do
not pick one: `package.json` conditional exports route `import { createRuntime }
from "ahwork"` to the right build, and your code does not change.

| | Browser | Node |
| --- | --- | --- |
| Worker | `new Worker(blob:)` | `new Worker(source, { eval: true })` |
| Entry | `dist/ahwork.js` | `dist/ahwork.node.js` |
| `maxWorkers: "auto"` | `navigator.hardwareConcurrency` | `os.availableParallelism()` (honours container CPU limits) |
| `workerUrl` | URL of a hosted script (CSP escape hatch) | path or `file:` URL of a worker file |
| Keeps the host alive | n/a | only while a job is in flight |

Everything above the backend — tasks, `context`, `inject`, `map`, timeouts,
`AbortSignal`, retries, auto-scaling, stats, graceful shutdown, transfer
lists — is shared code and behaves identically. `test/browser` and `test/node`
run overlapping suites to keep it that way.

If you need to be explicit (bundler quirks, dual-target tooling), the two builds
are also reachable directly as `ahwork/browser` and `ahwork/node`.

### On Node

```ts
import { createRuntime } from "ahwork"; // resolves to the worker_threads build

const runtime = createRuntime({ maxWorkers: 4 });

const hash = runtime.task((input: string) => {
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) | 0;
  return h;
});

console.log(await hash.map(["a", "b", "c"]));
```

Note there is no `shutdown()` in that snippet and the process still exits. An
idle pool is `unref`'d, so it never keeps Node alive by itself; a worker is
`ref`'d again for exactly as long as it has a job in flight, so `await` never
races process exit. Call `shutdown()` when you want the workers gone at a
specific moment (tests, a draining server) rather than whenever the process
ends.

Node gives the runtime one thing the browser cannot: a worker that dies
*without* throwing — an OOM kill, a stray `process.exit()` — emits `exit`, so
the job rejects with `WorkerCrashedError` instead of hanging forever.

## Install (local dev)

```bash
npm install
```

## Scripts

| Command             | What it does                                  |
| ------------------- | --------------------------------------------- |
| `npm run examples`  | Start the local docs site (Home / Examples / Demo / Tutorial / API) |
| `npm test`          | Unit tests in jsdom (no real Web Workers)     |
| `npm run test:node` | Execution tests on real `node:worker_threads` |
| `npm run test:browser` | Execution tests in Chromium via Playwright |
| `npm run test:all`  | Unit, then Node, then browser tests           |
| `npm run typecheck` | Type-check with `tsc --noEmit`                |
| `npm run build`     | Build the library (ESM + `.d.ts`)             |
| `npm run lint`      | Lint with ESLint                              |

`npm test` is fast and does **not** start Chrome. It checks types of the API,
the scheduler, timeouts/abort bookkeeping and fake workers. jsdom has no real
`Worker`, so it cannot run `fn.toString()` inside a blob worker.

`npm run test:node` runs the execution suite on real `worker_threads` — no
browser needed, so it is the fast way to check that a change to the shared
scheduler still works against a real worker.

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

A small React app, served by Vite from `examples/`. Each page is its own entry
point, so the URLs stay plain and shareable. React is a **dev dependency of the
playground only** — the library itself still ships with zero runtime deps.

Five pages:

| Page | URL | What it is |
| --- | --- | --- |
| Home | `/` or `/index.html` | What AhWork is + one runnable hello-world |
| Examples | `/examples.html` | All runnable cards (code + **Run**) |
| Demo | `/demo.html` | Live canvas: bots pathfinding in parallel across the pool |
| Tutorial | `/tutorial.html` | Concepts and how to use the API |
| API | `/docs.html` | Every type, option and error in one place |

```bash
npm run examples
```

Vite prints a local URL (usually `http://localhost:5173`). Open that — you land
on Home. Use the top nav, or go directly:

```
http://localhost:5173/
http://localhost:5173/examples.html
http://localhost:5173/demo.html
http://localhost:5173/tutorial.html
http://localhost:5173/docs.html
```

On Examples (and the Home demo), press **Run**. Output shows under the card and
in the DevTools console. The site imports the library from `src/`, so edits to
the library reload live.

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
class instances with methods). To share **helper functions** with a task, use
`inject` (below). Module imports inside workers are a later phase — see
[`plan.md`](./plan.md).

### Example: Sharing helper functions via `inject`

`context` carries **data**, but it cannot carry functions (structured clone
rejects them). To let a task call external helper functions, pass them via
`inject`. Each helper is serialized with `fn.toString()` — exactly like the task
itself — and rebuilt in the worker scope, so the task can call it by name.
Helpers may call one another, and `inject` combines with `context`.

```ts
const runtime = createRuntime();

const classify = runtime.task(
  (n: number) => (isPrime(n) ? "prime" : "composite"),
  {
    inject: {
      // self-contained helpers; they may call each other
      isPrime: (n: number) => {
        if (n < 2) return false;
        for (let i = 2; i * i <= n; i++) if (n % i === 0) return false;
        return true;
      },
    },
  },
);

console.log(await classify(7)); // "prime"

await runtime.shutdown();
```

Rules:

- Each helper must be **self-contained** (no closure/external variables of its
  own) — it is serialized by `fn.toString()`, just like a task.
- Keys must be valid JavaScript identifiers; invalid names (or non-function
  values) throw a `RuntimeError` at `task(...)` time.
- `inject` works with or without `context`. With both, the task receives the
  injected helpers by name **and** the `context` as its last argument.

> SECURITY: like the task body, injected helpers are rebuilt from source text in
> the worker. Never assemble them from untrusted input.

> **Minifiers rename call sites — `inject` keys they do not.** A task body
> ships as *text* while inject keys ship as *data*, so a bundler is free to
> rewrite your task from `astar(...)` to `xt(...)` while the key stays
> `"astar"`. AhWork closes that gap for you:
>
> - every helper is also published under its own `fn.name`, which a minifier
>   renames in lockstep with the call site, so the task finds it again;
> - a helper that neither the task nor another helper mentions by any of its
>   names is **rejected by `task(...)` immediately** with a `RuntimeError`,
>   because helpers live as `var`s in the worker's generated scope and a literal
>   reference is the only way to reach one.
>
> So you get either a working task or a loud, explanatory failure at
> registration — never a `ReferenceError` that shows up in production only.
> Writing helpers inline in the `inject` object, as above, keeps you out of the
> question entirely: inline helpers are free identifiers in the task body, which
> a bundler cannot rename (add `declare const isPrime: (n: number) => boolean`
> to satisfy TypeScript). Nesting the helper **inside** the task body works too.
> The planned build plugin (see [`plan.md`](./plan.md)) is what will eventually
> make all of this invisible.

### Example: Backpressure (`maxQueue`)

Bound the waiting queue so a saturated runtime rejects extra work with
`QueueFullError` instead of growing memory without limit.

```ts
const runtime = createRuntime({ maxWorkers: 1, maxQueue: 1 });

const hold = runtime.task(async (ms: number) => {
  await new Promise((r) => setTimeout(r, ms));
  return ms;
});

const running = hold(100); // occupies the worker
const queued = hold(100);  // fills the queue

try {
  await hold(100); // over capacity
} catch (err) {
  console.log((err as Error).name); // QueueFullError
}

await Promise.all([running, queued]);
await runtime.shutdown();
```

### Example: Retries on worker failures

`retries` re-runs a job **only** on infrastructure failures
(`WorkerCrashedError`, `WorkerSpawnError`). Task errors, timeouts and aborts are
never retried, and a `timeout` deadline spans all attempts.

```ts
const runtime = createRuntime({ maxWorkers: 2, retries: 2 });

const parse = runtime.task((input: string) => JSON.parse(input).value);

// If a worker crashes mid-flight, the job is transparently retried up to twice.
const value = await parse.run(['{"value":42}'], { retries: 2, timeout: 1000 });
console.log(value); // 42

await runtime.shutdown();
```

### Example: Zero-copy transfer (`autoTransfer`)

Move `ArrayBuffer`s (and typed-array buffers) into the worker instead of copying
them. Transferring **detaches** the source on the main thread.

```ts
const runtime = createRuntime({ autoTransfer: true });

const sum = runtime.task((buf: ArrayBuffer) => {
  const arr = new Uint8Array(buf);
  let s = 0;
  for (const x of arr) s += x;
  return s;
});

const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
console.log(await sum(buffer)); // 10
console.log(buffer.byteLength); // 0 — transferred, not copied

await runtime.shutdown();
```

You can also pass an explicit list per call: `task.run(args, { transfer: [buf] })`.

### Example: Disposing a task

When you create tasks dynamically, `task.dispose()` drops a task from the runtime
and every worker, freeing its serialized source and cached context.

```ts
const runtime = createRuntime();

const inc = runtime.task((n: number) => n + 1);
console.log(await inc(1)); // 2

inc.dispose();

try {
  await inc(1);
} catch (err) {
  console.log((err as Error).name); // RuntimeError
}

await runtime.shutdown();
```

### Example: Hosted worker backend (`workerUrl`) for strict CSP

If a Content-Security-Policy blocks `blob:` workers, host the exported
`workerSourceCode` as a static file and point `workerUrl` at it.

```ts
import { createRuntime, workerSourceCode } from "ahwork";

// At build/deploy time, write `workerSourceCode` to e.g. /ahwork.worker.js.
// (Shown here building the URL at runtime for illustration.)
const workerUrl = URL.createObjectURL(
  new Blob([workerSourceCode], { type: "text/javascript" }),
);

const runtime = createRuntime({ maxWorkers: 2, workerUrl });

const square = runtime.task((n: number) => n * n);
console.log(await square.map([2, 3, 4])); // [4, 9, 16]

await runtime.shutdown();
URL.revokeObjectURL(workerUrl);
```

---

## Runtime configuration

```ts
createRuntime({
  minWorkers: 0,        // workers kept warm; prewarmed on creation. Default: 0
  maxWorkers: "auto",   // upper bound; "auto" = available cores (see Backends)
  idleTimeout: 10_000,  // ms an idle worker lives before termination (0 = never)
  taskTimeout: 0,       // default per-task timeout (ms); 0 = no timeout
  maxQueue: 0,          // max waiting jobs (backpressure); 0 = unbounded
  retries: 0,           // auto-retries on worker crash/spawn failure
  autoTransfer: false,  // auto-move ArrayBuffers & co. zero-copy
  // workerUrl: "/ahwork.worker.js", // hosted worker backend for strict CSP
});
```

Invalid numeric options are normalized: `maxWorkers` is forced to at least `1`,
`minWorkers` is clamped into `[0, maxWorkers]`, and `NaN`/negative values fall
back to their defaults.

Multiple independent runtimes can coexist; there is no global singleton.

`await runtime.shutdown()` is immediate: queued and running jobs reject with
`RuntimeShutdownError`, workers die, and any backend resource (the browser's
blob URL) is released.
`await runtime.shutdown({ graceful: true })` still rejects jobs that have not
started, but waits for jobs that are already running. Add
`{ graceful: true, timeout }` to force-stop stragglers after a deadline.
Shutdown is idempotent (first call wins); a later immediate `shutdown()`
**escalates** a pending graceful one.

## When are workers useful?

Workers move **CPU-heavy** work off the main thread and let suitable workloads
run in parallel across cores. They do **not** make arbitrary asynchronous code
faster — I/O-bound or already-async work usually gains nothing, and there is
per-job serialization and worker-startup overhead.

Rule of thumb: if deleting that computation would make your UI smooth again, it
belongs in a worker. If the function mostly waits on the network, it does not.

On a server the same rule reads differently but means the same thing: one
synchronous 200 ms computation blocks the event loop, so *every* concurrent
request waits 200 ms. Moving it to the pool keeps the loop answering while the
work happens elsewhere.

## Limitations

None of these are bugs — they follow from how Web Workers actually work. Worth
reading once before you adopt the library.

- **Closures aren't serialized.** `fn.toString()` captures only the function
  text. External variables, imports, and `this` do not exist in the worker. Pass
  external **data** via the `context` task option and external **helper
  functions** via `inject` (see the examples above); module imports inside
  workers are a later phase.
- **Minifiers and `inject`.** Because the task body is shipped as text, a
  bundler that renames identifiers can break the link between a task and a
  helper handed to `inject` by shorthand. AhWork detects and repairs the usual
  case and refuses the rest at `task(...)` time rather than failing inside a
  worker — see the note under the `inject` example.
- **Structured clone restrictions.** Arguments/results must be structured-clone
  compatible (no functions, DOM nodes, or class instances with methods).
- **CSP (browser only).** The default `blob:` worker can be blocked by a strict
  Content Security Policy (`worker-src` / `script-src`). Workaround: host the
  exported `workerSourceCode` as a static file and pass
  `createRuntime({ workerUrl })`. A failed worker creation rejects with
  `WorkerSpawnError`. Node has no equivalent restriction.
- **No shared memory.** Each worker is an isolated realm with its own heap; a
  `context` is a real per-worker copy, and nothing is shared between tasks
  except what you pass per call. That is what makes the model safe, and also
  why very small jobs are not worth dispatching.
- **Security.** The worker reconstructs functions from source text. Never pass
  code assembled from untrusted/user input to `runtime.task(...)`.
- **Startup overhead & browser support.** First job pays worker startup cost;
  targets modern browsers.

## License

MIT
