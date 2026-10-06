import { codeBlock, mountPage } from "../common";

mountPage(
  "tutorial",
  `
  <h1>Tutorial</h1>
  <p class="lead">
    How AhWork is meant to be used: the mental model, then the usual operations.
  </p>

  <h2>Mental model</h2>
  <p>
    Think in work, not in workers. You own a <strong>runtime</strong>.
    You register <strong>tasks</strong> (plain functions). Each call becomes a
    <strong>job</strong>. The <strong>scheduler</strong> assigns jobs to a
    <strong>pool</strong> of Web Workers that you never see.
  </p>
  ${codeBlock(`developer
  → Task
    → Job
      → Scheduler
        → Worker Pool
          → Web Workers`)}

  <h2>1. Create a runtime</h2>
  <p>
    Importing the package does not spawn workers. Workers appear when work is
    submitted, or immediately if <code>minWorkers</code> asks for warmup.
  </p>
  ${codeBlock(`import { createRuntime } from "ahwork";

const runtime = createRuntime({
  minWorkers: 0,       // keep this many warm (default 0)
  maxWorkers: "auto",  // hardwareConcurrency || 4
  idleTimeout: 10_000, // terminate idle workers after this (ms)
  taskTimeout: 0,      // default per-job timeout; 0 = none
});`)}

  <h2>2. Register a task</h2>
  <p>
    <code>runtime.task(fn)</code> serializes the function with
    <code>fn.toString()</code> and returns a callable handle. Call it like an
    async function, or use <code>task.run(args, options)</code> for timeout /
    abort / transfer.
  </p>
  ${codeBlock(`const square = runtime.task((n: number) => n * n);

await square(12);                 // 144
await square.run([12], { timeout: 1000 });`)}
  <p>
    Closures are <strong>not</strong> captured. Pass external data with
    <code>context</code> — it is sent once, cached on each worker, and injected
    as the last argument. You still call the task with the normal args only.
  </p>
  ${codeBlock(`const multiplier = 10;

const scale = runtime.task(
  (x: number, ctx: { multiplier: number }) => x * ctx.multiplier,
  { context: { multiplier } },
);

await scale(5); // 50`)}

  <h2>3. Run many jobs</h2>
  <p>
    Independent calls run in parallel up to <code>maxWorkers</code>. Use
    <code>task.map()</code> when you have a list: results keep input order.
    Single-argument tasks take values; multi-argument tasks take tuples.
  </p>
  ${codeBlock(`await square.map([1, 2, 3, 4, 5]);          // [1, 4, 9, 16, 25]
await add.map([[1, 2], [10, 20], [100, 200]]); // [3, 30, 300]`)}

  <h2>4. Cancel and time out</h2>
  <p>
    Use a standard <code>AbortSignal</code>. A queued job is dropped; a running
    job terminates its worker (MVP). Timeouts do the same and reject with
    <code>TaskTimeoutError</code>.
  </p>
  ${codeBlock(`const controller = new AbortController();
const promise = heavy.run([n], { signal: controller.signal, timeout: 5000 });
controller.abort(); // AbortError`)}

  <h2>5. Inspect and shut down</h2>
  <p>
    <code>runtime.stats()</code> is a cheap snapshot. Always
    <code>await runtime.shutdown()</code> when you are done — it rejects queued
    jobs, terminates workers, and revokes the blob URL.
  </p>
  ${codeBlock(`console.log(runtime.stats());
await runtime.shutdown();`)}

  <h2>When this helps</h2>
  <p>
    Workers help when you have <strong>CPU-heavy</strong> work that would block
    the UI, and when that work can be split into independent jobs. They do not
    make I/O or already-async code faster. There is serialization and worker
    startup cost on the first job.
  </p>
  <p>
    Next: the <a href="/examples.html">examples</a> page (run each card) or the
    dry <a href="/docs.html">API reference</a>.
  </p>
  `,
);
