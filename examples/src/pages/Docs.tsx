import { Layout } from "../components/Layout";
import { CodeBlock } from "../components/CodeBlock";

const CREATE_RUNTIME = `function createRuntime(options?: RuntimeOptions): Runtime;`;

const RUNTIME = `interface Runtime {
  // plain task
  task<A extends unknown[], R>(fn: (...args: A) => R): RuntimeTask<A, R>;
  // with a context (appended as the task's last argument)
  task<A extends unknown[], C, R>(
    fn: (...args: [...A, C]) => R,
    options: TaskOptions<C>,
  ): RuntimeTask<A, R>;
  // with injected helpers only (no context)
  task<A extends unknown[], R>(
    fn: (...args: A) => R,
    options: InjectOptions,
  ): RuntimeTask<A, R>;
  stats(): RuntimeStats;
  shutdown(options?: ShutdownOptions): Promise<void>;
}`;

const SHUTDOWN_OPTIONS = `interface ShutdownOptions {
  graceful?: boolean; // wait for running jobs (default false = immediate)
  timeout?: number;   // ms; with graceful, force-stop after the deadline
}`;

const TASK_OPTIONS = `type InjectMap = Record<string, (...args: any[]) => any>;

interface TaskOptions<C> {
  context: C;
  inject?: InjectMap;
}

// Or inject helpers without any context:
interface InjectOptions {
  inject: InjectMap;
  context?: never;
}`;

const RUNTIME_TASK = `interface RuntimeTask<A extends unknown[], R> {
  (...args: A): Promise<Awaited<R>>;
  run(args: A, options?: RunOptions): Promise<Awaited<R>>;
  map(inputs: MapInput<A>, options?: RunOptions): Promise<Awaited<R>[]>;
  dispose(): void;
}`;

const RUNTIME_STATS = `interface RuntimeStats {
  workers: number;
  busyWorkers: number;
  idleWorkers: number;
  queuedJobs: number;
  runningJobs: number;
  completedJobs: number;
  failedJobs: number;
  averageWaitTime: number;
  averageExecutionTime: number;
}`;

const EXPORTS = `export { createRuntime, workerSourceCode } from "ahwork";
// Node build only:
export { nodeWorkerPrelude } from "ahwork";

export type {
  Runtime,
  RuntimeOptions,
  RuntimeTask,
  RunOptions,
  MapInput,
  RuntimeStats,
  ShutdownOptions,
  TaskOptions,
  InjectOptions,
  InjectMap,
  TransferableValue,
};
export {
  RuntimeError,
  AbortError,
  TaskTimeoutError,
  WorkerCrashedError,
  WorkerSpawnError,
  RuntimeShutdownError,
  QueueFullError,
};`;

export function Docs() {
  return (
    <Layout active="docs">
      <h1>API reference</h1>
      <p className="lead">
        Every public type, option and error, in one place. If you are just
        getting started, the <a href="/tutorial.html">tutorial</a> is a gentler
        path — this page is the lookup table you come back to.
      </p>

      <h2>createRuntime</h2>
      <CodeBlock code={CREATE_RUNTIME} />
      <p>
        Creates an independent runtime. Importing the module does not spawn
        workers.
      </p>

      <h2>Backends</h2>
      <p>
        The same <code>createRuntime</code> runs on two worker implementations.
        You never choose: conditional exports in <code>package.json</code> route{" "}
        <code>import {"{ createRuntime }"} from &quot;ahwork&quot;</code> to the
        right build. Everything above the backend — tasks, <code>context</code>,{" "}
        <code>inject</code>, <code>map</code>, timeouts, <code>AbortSignal</code>,
        retries, auto-scaling, stats, shutdown, transfer lists — is shared code
        and behaves identically.
      </p>
      <table>
        <thead>
          <tr>
            <th></th>
            <th>Browser</th>
            <th>Node 18+</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Worker</td>
            <td>
              <code>new Worker(blob:)</code>
            </td>
            <td>
              <code>worker_threads</code>, <code>{"{ eval: true }"}</code>
            </td>
          </tr>
          <tr>
            <td>Entry</td>
            <td>
              <code>dist/ahwork.js</code> · <code>ahwork/browser</code>
            </td>
            <td>
              <code>dist/ahwork.node.js</code> · <code>ahwork/node</code>
            </td>
          </tr>
          <tr>
            <td>Keeps the host alive</td>
            <td>
              <em>—</em>
            </td>
            <td>
              Only while a job is in flight. An idle pool is{" "}
              <code>unref</code>&apos;d, so a forgotten{" "}
              <code>shutdown()</code> never pins the process, and an{" "}
              <code>await</code> never races process exit.
            </td>
          </tr>
          <tr>
            <td>Silent worker death</td>
            <td>Job hangs — the platform reports nothing</td>
            <td>
              <code>exit</code> fires, so the job rejects with{" "}
              <code>WorkerCrashedError</code>
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        This page runs in a browser, so every runnable example on this site uses
        the Web Worker backend. The Node backend is covered by its own execution
        suite (<code>npm run test:node</code>), which overlaps the browser one on
        purpose.
      </p>

      <h2>RuntimeOptions</h2>
      <table>
        <thead>
          <tr>
            <th>Field</th>
            <th>Type</th>
            <th>Default</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>minWorkers</code>
            </td>
            <td>
              <code>number</code>
            </td>
            <td>
              <code>0</code>
            </td>
            <td>
              Warm workers kept alive. Prewarmed on create. Clamped to{" "}
              <code>[0, maxWorkers]</code>.
            </td>
          </tr>
          <tr>
            <td>
              <code>maxWorkers</code>
            </td>
            <td>
              <code>number | &quot;auto&quot;</code>
            </td>
            <td>
              <code>&quot;auto&quot;</code>
            </td>
            <td>
              Available cores: <code>navigator.hardwareConcurrency</code> in the
              browser, <code>os.availableParallelism()</code> on Node. Falls
              back to <code>4</code>. Always ≥ 1.
            </td>
          </tr>
          <tr>
            <td>
              <code>idleTimeout</code>
            </td>
            <td>
              <code>number</code>
            </td>
            <td>
              <code>10000</code>
            </td>
            <td>
              Ms an idle worker lives before termination. <code>0</code>{" "}
              disables.
            </td>
          </tr>
          <tr>
            <td>
              <code>taskTimeout</code>
            </td>
            <td>
              <code>number</code>
            </td>
            <td>
              <code>0</code>
            </td>
            <td>
              Default per-job timeout in ms. <code>0</code> = none.
            </td>
          </tr>
          <tr>
            <td>
              <code>maxQueue</code>
            </td>
            <td>
              <code>number</code>
            </td>
            <td>
              <code>0</code>
            </td>
            <td>
              Max jobs allowed to wait when saturated (backpressure). Over cap →{" "}
              <code>QueueFullError</code>. <code>0</code> = unbounded.
            </td>
          </tr>
          <tr>
            <td>
              <code>retries</code>
            </td>
            <td>
              <code>number</code>
            </td>
            <td>
              <code>0</code>
            </td>
            <td>
              Auto-retries on worker <em>infrastructure</em> errors (
              <code>WorkerCrashedError</code>, <code>WorkerSpawnError</code>).
              Task errors / timeout / abort are never retried.
            </td>
          </tr>
          <tr>
            <td>
              <code>autoTransfer</code>
            </td>
            <td>
              <code>boolean</code>
            </td>
            <td>
              <code>false</code>
            </td>
            <td>
              Auto-detect Transferables (ArrayBuffers, typed-array buffers,
              ports, streams…) in args and move them zero-copy.{" "}
              <strong>Detaches</strong> the source buffer.
            </td>
          </tr>
          <tr>
            <td>
              <code>workerUrl</code>
            </td>
            <td>
              <code>string</code>
            </td>
            <td>
              <em>—</em>
            </td>
            <td>
              Use a worker entry you host yourself. In the browser: a URL
              serving <code>workerSourceCode</code>, instead of a{" "}
              <code>blob:</code> URL (strict-CSP escape hatch). On Node: a file
              path or <code>file:</code> URL, whose contents must be{" "}
              <code>nodeWorkerPrelude + workerSourceCode</code>.
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        Invalid numeric options are normalized (NaN/negative → safe default,
        fractions floored).
      </p>

      <h2>Runtime</h2>
      <CodeBlock code={RUNTIME} />
      <table>
        <thead>
          <tr>
            <th>Method</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>task(fn)</code>
            </td>
            <td>Register a function. Returns a callable task handle.</td>
          </tr>
          <tr>
            <td>
              <code>task(fn, {"{ context }"})</code>
            </td>
            <td>
              Same, injecting serializable <code>context</code> as the last
              argument inside the worker.
            </td>
          </tr>
          <tr>
            <td>
              <code>task(fn, {"{ inject }"})</code>
            </td>
            <td>
              Same, making the given helper functions available by name inside
              the worker (with or without <code>context</code>).
            </td>
          </tr>
          <tr>
            <td>
              <code>stats()</code>
            </td>
            <td>Lightweight snapshot of pool and job counters.</td>
          </tr>
          <tr>
            <td>
              <code>shutdown()</code>
            </td>
            <td>
              Immediate: reject queued and running jobs, terminate workers,
              revoke blob URL. Calling a task afterwards throws{" "}
              <code>RuntimeShutdownError</code>.
            </td>
          </tr>
          <tr>
            <td>
              <code>shutdown({"{ graceful: true }"})</code>
            </td>
            <td>
              Reject queued jobs, wait for jobs that are already running, then
              terminate.
            </td>
          </tr>
          <tr>
            <td>
              <code>shutdown({"{ graceful: true, timeout }"})</code>
            </td>
            <td>
              As above, but force-reject still-running jobs after{" "}
              <code>timeout</code> ms.
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        Shutdown is idempotent (first call wins). A later immediate{" "}
        <code>shutdown()</code> <strong>escalates</strong> a pending graceful
        one, force-rejecting running jobs.
      </p>

      <h2>ShutdownOptions</h2>
      <CodeBlock code={SHUTDOWN_OPTIONS} />

      <h2>TaskOptions</h2>
      <CodeBlock code={TASK_OPTIONS} />
      <p>
        <code>context</code> must be structured-clone compatible. Sent once per
        worker, cached there.
      </p>
      <p>
        <code>inject</code> helpers are serialized with{" "}
        <code>fn.toString()</code> (like the task) and rebuilt in the worker
        scope, so the task can call them by name; they may call one another.
        Each helper must be self-contained; keys must be valid JS identifiers
        (otherwise <code>task()</code> throws <code>RuntimeError</code>). A
        helper is also published under its own <code>fn.name</code>, so a
        minifier that renames the call site inside the task body cannot
        disconnect it from its inject key; and a helper that nothing mentions by
        any of its names is rejected by <code>task()</code> rather than becoming
        a <code>ReferenceError</code> inside the worker.
      </p>

      <h2>RuntimeTask</h2>
      <CodeBlock code={RUNTIME_TASK} />
      <table>
        <thead>
          <tr>
            <th>Member</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>task(...args)</code>
            </td>
            <td>
              Submit one job. Same as <code>run(args)</code>.
            </td>
          </tr>
          <tr>
            <td>
              <code>run(args, options?)</code>
            </td>
            <td>Submit with cancellation, timeout, transfer, retries.</td>
          </tr>
          <tr>
            <td>
              <code>map(inputs, options?)</code>
            </td>
            <td>
              Submit many jobs. Results keep input order. Single-arg:{" "}
              <code>S[]</code>. Multi-arg: <code>A[]</code> (tuples).
            </td>
          </tr>
          <tr>
            <td>
              <code>dispose()</code>
            </td>
            <td>
              Drop this task from the runtime and every worker (frees its source
              + cached context). Calling the task afterwards rejects with{" "}
              <code>RuntimeError</code>.
            </td>
          </tr>
        </tbody>
      </table>

      <h2>RunOptions</h2>
      <table>
        <thead>
          <tr>
            <th>Field</th>
            <th>Type</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>signal</code>
            </td>
            <td>
              <code>AbortSignal</code>
            </td>
            <td>
              Cancel: queued jobs are dropped; running jobs terminate the
              worker. Rejects with <code>AbortError</code>.
            </td>
          </tr>
          <tr>
            <td>
              <code>timeout</code>
            </td>
            <td>
              <code>number</code>
            </td>
            <td>
              Per-job deadline from submission (ms). Overrides{" "}
              <code>taskTimeout</code>. Spans all retries. Rejects with{" "}
              <code>TaskTimeoutError</code>.
            </td>
          </tr>
          <tr>
            <td>
              <code>transfer</code>
            </td>
            <td>
              <code>TransferableValue[]</code>
            </td>
            <td>
              Explicit transfer list for <code>postMessage</code> (merged with
              auto-detected ones when <code>autoTransfer</code> is on). Not the
              DOM&apos;s <code>Transferable</code>: these types also ship in the
              Node build, where <code>lib.dom</code> does not exist.
            </td>
          </tr>
          <tr>
            <td>
              <code>autoTransfer</code>
            </td>
            <td>
              <code>boolean</code>
            </td>
            <td>
              Override <code>RuntimeOptions.autoTransfer</code> for this call.
            </td>
          </tr>
          <tr>
            <td>
              <code>retries</code>
            </td>
            <td>
              <code>number</code>
            </td>
            <td>
              Override <code>RuntimeOptions.retries</code> for this call.
            </td>
          </tr>
        </tbody>
      </table>

      <h2>RuntimeStats</h2>
      <CodeBlock code={RUNTIME_STATS} />

      <h2>Errors</h2>
      <table>
        <thead>
          <tr>
            <th>Class</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>RuntimeError</code>
            </td>
            <td>
              Base class for AhWork errors. Also thrown when calling a disposed
              task.
            </td>
          </tr>
          <tr>
            <td>
              <code>AbortError</code>
            </td>
            <td>
              Job cancelled via <code>AbortSignal</code>. Native reason in{" "}
              <code>cause</code>.
            </td>
          </tr>
          <tr>
            <td>
              <code>TaskTimeoutError</code>
            </td>
            <td>Job exceeded its timeout.</td>
          </tr>
          <tr>
            <td>
              <code>WorkerCrashedError</code>
            </td>
            <td>Worker died or became unusable. Retryable.</td>
          </tr>
          <tr>
            <td>
              <code>WorkerSpawnError</code>
            </td>
            <td>
              Worker could not be created (e.g. strict CSP blocks{" "}
              <code>blob:</code>). Retryable.
            </td>
          </tr>
          <tr>
            <td>
              <code>RuntimeShutdownError</code>
            </td>
            <td>
              Task invoked after <code>shutdown()</code>, or queued job dropped
              on shutdown.
            </td>
          </tr>
          <tr>
            <td>
              <code>QueueFullError</code>
            </td>
            <td>
              Submission rejected because the queue hit <code>maxQueue</code>.
            </td>
          </tr>
        </tbody>
      </table>

      <h2>Exports</h2>
      <CodeBlock code={EXPORTS} />
      <p>
        <code>workerSourceCode</code> is the raw worker runtime text — host it
        as a <code>.js</code> file and pass its URL via{" "}
        <code>createRuntime({"{ workerUrl }"})</code> under a strict CSP. The
        Node build adds one export, <code>nodeWorkerPrelude</code>: the shim
        that gives that same source a <code>self</code> to attach to under{" "}
        <code>worker_threads</code>. You only need it if you host the worker
        file yourself; the default <code>{"{ eval: true }"}</code> path prepends
        it for you.
      </p>
    </Layout>
  );
}
