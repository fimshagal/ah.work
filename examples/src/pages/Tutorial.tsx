import { Layout } from "../components/Layout";
import { CodeBlock } from "../components/CodeBlock";

const MENTAL_MODEL = `developer
  → Task
    → Job
      → Scheduler
        → Worker Pool
          → Web Workers`;

const CREATE_RUNTIME = `import { createRuntime } from "ahwork";

const runtime = createRuntime({
  minWorkers: 0,       // keep this many warm (default 0)
  maxWorkers: "auto",  // hardwareConcurrency || 4
  idleTimeout: 10_000, // terminate idle workers after this (ms)
  taskTimeout: 0,      // default per-job timeout; 0 = none
  maxQueue: 0,         // backpressure cap; 0 = unbounded
  retries: 0,          // auto-retry on worker crash/spawn failure
  autoTransfer: false, // auto-move ArrayBuffers zero-copy
  // workerUrl: "/ahwork.worker.js", // hosted backend for strict CSP
});`;

const REGISTER_TASK = `const square = runtime.task((n: number) => n * n);

await square(12);                 // 144
await square.run([12], { timeout: 1000 });`;

const WITH_CONTEXT = `const multiplier = 10;

const scale = runtime.task(
  (x: number, ctx: { multiplier: number }) => x * ctx.multiplier,
  { context: { multiplier } },
);

await scale(5); // 50`;

const WITH_INJECT = `const classify = runtime.task(
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

await classify(7); // "prime"`;

const MAP_USAGE = `await square.map([1, 2, 3, 4, 5]);          // [1, 4, 9, 16, 25]
await add.map([[1, 2], [10, 20], [100, 200]]); // [3, 30, 300]`;

const CANCEL = `const controller = new AbortController();
const promise = heavy.run([n], { signal: controller.signal, timeout: 5000 });
controller.abort(); // AbortError`;

const STATS_SHUTDOWN = `console.log(runtime.stats());
await runtime.shutdown();                          // immediate
await runtime.shutdown({ graceful: true });        // wait for running jobs
await runtime.shutdown({ graceful: true, timeout: 2000 }); // ...but not forever`;

const RETRIES = `await heavy.run([n], { retries: 2 });
await heavy.run([n], { timeout: 1000, retries: 2 }); // 1s total across retries`;

const TRANSFER = `const r = createRuntime({ autoTransfer: true });
await parse.run([buffer]);       // buffer moved, not copied
// or per call, with an explicit list:
await parse.run([buffer], { transfer: [buffer] });`;

const CSP = `import { createRuntime, workerSourceCode } from "ahwork";
// write workerSourceCode to /ahwork.worker.js at build/deploy time
const runtime = createRuntime({ workerUrl: "/ahwork.worker.js" });`;

export function Tutorial() {
  return (
    <Layout active="tutorial">
      <h1>Tutorial</h1>
      <p className="lead">
        Read this once and you will know how AhWork is meant to be used. We
        start with the mental model — which is most of the battle — then walk
        through the operations you will actually reach for, and finish with the
        mistakes everyone makes the first time.
      </p>

      <h2>Mental model</h2>
      <p>
        Think in work, not in workers. You own a <strong>runtime</strong>. You
        register <strong>tasks</strong> (plain functions). Each call becomes a{" "}
        <strong>job</strong>. The <strong>scheduler</strong> assigns jobs to a{" "}
        <strong>pool</strong> of Web Workers that you never see.
      </p>
      <CodeBlock code={MENTAL_MODEL} />

      <h2>1. Create a runtime</h2>
      <p>
        Importing the package does not spawn workers. Workers appear when work
        is submitted, or immediately if <code>minWorkers</code> asks for warmup.
      </p>
      <CodeBlock code={CREATE_RUNTIME} />

      <h2>2. Register a task</h2>
      <p>
        <code>runtime.task(fn)</code> serializes the function with{" "}
        <code>fn.toString()</code> and returns a callable handle. Call it like
        an async function, or use <code>task.run(args, options)</code> for
        timeout / abort / transfer.
      </p>
      <CodeBlock code={REGISTER_TASK} />
      <p>
        Closures are <strong>not</strong> captured. Pass external data with{" "}
        <code>context</code> — it is sent once, cached on each worker, and
        injected as the last argument. You still call the task with the normal
        args only.
      </p>
      <CodeBlock code={WITH_CONTEXT} />
      <p>
        To share <strong>helper functions</strong> (which <code>context</code>{" "}
        cannot carry), pass them via <code>inject</code>. Each helper is
        serialized like the task and rebuilt in the worker, so the task can call
        it by name.
      </p>
      <CodeBlock code={WITH_INJECT} />
      <p>
        Note the shape above: the helper is written <em>inline</em> in the{" "}
        <code>inject</code> object. That is the habit worth keeping. The task
        body travels as text and the keys travel as data, so a minifier can
        rewrite the call inside your task to <code>xt(...)</code> while the key
        stays <code>&quot;isPrime&quot;</code>. AhWork covers for that — it also
        publishes each helper under its own <code>fn.name</code>, and refuses at{" "}
        <code>task()</code> time any helper that nothing mentions — so you will
        never meet that bug as a mysterious <code>ReferenceError</code> in
        production. An inline helper simply never gets into the situation. The
        other safe option is to nest the helper inside the task body; that is
        what the <a href="./demo.html">bots demo</a> does.
      </p>

      <h2>3. Run many jobs</h2>
      <p>
        Independent calls run in parallel up to <code>maxWorkers</code>. Use{" "}
        <code>task.map()</code> when you have a list: results keep input order.
        Single-argument tasks take values; multi-argument tasks take tuples.
      </p>
      <CodeBlock code={MAP_USAGE} />

      <h2>4. Cancel and time out</h2>
      <p>
        Use a standard <code>AbortSignal</code>. A queued job is dropped; a
        running job terminates its worker (MVP). Timeouts do the same and reject
        with <code>TaskTimeoutError</code>.
      </p>
      <CodeBlock code={CANCEL} />

      <h2>5. Inspect and shut down</h2>
      <p>
        <code>runtime.stats()</code> is a cheap snapshot. Always{" "}
        <code>await runtime.shutdown()</code> when you are done — it rejects
        queued jobs, terminates workers, and revokes the blob URL. Graceful
        shutdown waits for running jobs; add a <code>timeout</code> to cap the
        wait.
      </p>
      <CodeBlock code={STATS_SHUTDOWN} />

      <h2>6. Reliability &amp; performance options</h2>
      <p>
        <strong>Backpressure.</strong> Cap the waiting queue with{" "}
        <code>maxQueue</code>; submissions over the cap reject with{" "}
        <code>QueueFullError</code> instead of growing memory without bound.
      </p>
      <p>
        <strong>Retries.</strong> <code>retries</code> re-runs a job only on
        worker <em>infrastructure</em> failures (<code>WorkerCrashedError</code>
        , <code>WorkerSpawnError</code>). Task errors, timeouts and aborts are
        never retried. The timeout deadline spans all attempts.
      </p>
      <CodeBlock code={RETRIES} />
      <p>
        <strong>Zero-copy transfer.</strong> Turn on <code>autoTransfer</code>{" "}
        to move <code>ArrayBuffer</code>s (and typed-array buffers) into the
        worker instead of cloning. Transferring <strong>detaches</strong> the
        source — its <code>byteLength</code> becomes <code>0</code> on the main
        thread.
      </p>
      <CodeBlock code={TRANSFER} />
      <p>
        <strong>Free a task.</strong> If you create tasks dynamically, call{" "}
        <code>task.dispose()</code> to drop them from the runtime and all
        workers.
      </p>
      <p>
        <strong>Strict CSP.</strong> If a Content-Security-Policy blocks{" "}
        <code>blob:</code> workers, host the exported{" "}
        <code>workerSourceCode</code> as a file and point <code>workerUrl</code>{" "}
        at it.
      </p>
      <CodeBlock code={CSP} />

      <h2>When this helps</h2>
      <p>
        Workers help when you have <strong>CPU-heavy</strong> work that would
        block the UI, and when that work can be split into independent jobs.
        They do not make I/O or already-async code faster. There is
        serialization and worker startup cost on the first job.
      </p>
      <p>
        Rule of thumb: if deleting that computation would make your UI smooth
        again, it belongs in a worker. If the function mostly waits on the
        network, it does not.
      </p>

      <h2>Common first-time mistakes</h2>
      <p>
        Almost everyone hits at least one of these. None of them mean the
        library is broken — they are consequences of code crossing a thread
        boundary.
      </p>
      <ul className="features">
        <li>
          <strong>Reaching for a variable from the surrounding scope.</strong>{" "}
          The task is serialized with <code>fn.toString()</code>, so that
          variable simply does not exist in the worker and you get a{" "}
          <code>ReferenceError</code>. Pass data through <code>context</code>{" "}
          and functions through <code>inject</code>.
        </li>
        <li>
          <strong>Sending something structured clone cannot copy.</strong> Class
          instances with methods, DOM nodes, and functions all fail with{" "}
          <code>DataCloneError</code>. Send plain data and rebuild objects
          inside the task.
        </li>
        <li>
          <strong>Expecting one job to be faster.</strong> A single call is{" "}
          <em>slower</em> than calling the function directly — you pay
          serialization and startup. The win is that the UI stays responsive,
          and that many jobs run at once.
        </li>
        <li>
          <strong>
            Forgetting <code>shutdown()</code>.
          </strong>{" "}
          Workers outlive your component or script until you terminate them.
          Always <code>await runtime.shutdown()</code> when you are done.
        </li>
        <li>
          <strong>Reusing a buffer after transferring it.</strong> With{" "}
          <code>autoTransfer</code> (or an explicit <code>transfer</code> list)
          the <code>ArrayBuffer</code> is <em>moved</em>; on the main thread its{" "}
          <code>byteLength</code> becomes <code>0</code>. Copy it first if you
          still need it.
        </li>
      </ul>

      <p>
        Next: the <a href="/examples.html">examples</a> page (run each card),
        the live <a href="/demo.html">demo</a> (bots pathfinding in parallel),
        or the <a href="/docs.html">API reference</a> when you need exact
        signatures.
      </p>
    </Layout>
  );
}
