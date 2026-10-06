import { codeBlock, mountPage } from "../common";

mountPage(
  "docs",
  `
  <h1>API reference</h1>
  <p class="lead">Public surface only. Types and methods as they exist today.</p>

  <h2>createRuntime</h2>
  ${codeBlock(`function createRuntime(options?: RuntimeOptions): Runtime;`)}
  <p>Creates an independent runtime. Importing the module does not spawn workers.</p>

  <h2>RuntimeOptions</h2>
  <table>
    <thead><tr><th>Field</th><th>Type</th><th>Default</th><th>Description</th></tr></thead>
    <tbody>
      <tr><td><code>minWorkers</code></td><td><code>number</code></td><td><code>0</code></td><td>Warm workers kept alive. Prewarmed on create.</td></tr>
      <tr><td><code>maxWorkers</code></td><td><code>number | "auto"</code></td><td><code>"auto"</code></td><td><code>navigator.hardwareConcurrency || 4</code>.</td></tr>
      <tr><td><code>idleTimeout</code></td><td><code>number</code></td><td><code>10000</code></td><td>Ms an idle worker lives before termination. <code>0</code> disables.</td></tr>
      <tr><td><code>taskTimeout</code></td><td><code>number</code></td><td><code>0</code></td><td>Default per-job timeout in ms. <code>0</code> = none.</td></tr>
    </tbody>
  </table>

  <h2>Runtime</h2>
  ${codeBlock(`interface Runtime {
  task<A extends unknown[], R>(fn: (...args: A) => R): RuntimeTask<A, R>;
  task<A extends unknown[], C, R>(
    fn: (...args: [...A, C]) => R,
    options: TaskOptions<C>,
  ): RuntimeTask<A, R>;
  stats(): RuntimeStats;
  shutdown(options?: ShutdownOptions): Promise<void>;
}`)}
  <table>
    <thead><tr><th>Method</th><th>Description</th></tr></thead>
    <tbody>
      <tr><td><code>task(fn)</code></td><td>Register a function. Returns a callable task handle.</td></tr>
      <tr><td><code>task(fn, { context })</code></td><td>Same, injecting serializable <code>context</code> as the last argument inside the worker.</td></tr>
      <tr><td><code>stats()</code></td><td>Lightweight snapshot of pool and job counters.</td></tr>
      <tr><td><code>shutdown()</code></td><td>Immediate: reject queued and running jobs, terminate workers, revoke blob URL. Calling a task afterwards throws <code>RuntimeShutdownError</code>.</td></tr>
      <tr><td><code>shutdown({ graceful: true })</code></td><td>Reject queued jobs, wait for jobs that are already running, then terminate.</td></tr>
    </tbody>
  </table>

  <h2>TaskOptions</h2>
  ${codeBlock(`interface TaskOptions<C> {
  context: C;
}`)}
  <p><code>context</code> must be structured-clone compatible. Sent once per worker, cached there.</p>

  <h2>RuntimeTask</h2>
  ${codeBlock(`interface RuntimeTask<A extends unknown[], R> {
  (...args: A): Promise<Awaited<R>>;
  run(args: A, options?: RunOptions): Promise<Awaited<R>>;
  map(inputs: MapInput<A>, options?: RunOptions): Promise<Awaited<R>[]>;
}`)}
  <table>
    <thead><tr><th>Member</th><th>Description</th></tr></thead>
    <tbody>
      <tr><td><code>task(...args)</code></td><td>Submit one job. Same as <code>run(args)</code>.</td></tr>
      <tr><td><code>run(args, options?)</code></td><td>Submit with cancellation, timeout, or transfer list.</td></tr>
      <tr><td><code>map(inputs, options?)</code></td><td>Submit many jobs. Results keep input order. Single-arg: <code>S[]</code>. Multi-arg: <code>A[]</code> (tuples).</td></tr>
    </tbody>
  </table>

  <h2>RunOptions</h2>
  <table>
    <thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead>
    <tbody>
      <tr><td><code>signal</code></td><td><code>AbortSignal</code></td><td>Cancel: queued jobs are dropped; running jobs terminate the worker. Rejects with <code>AbortError</code>.</td></tr>
      <tr><td><code>timeout</code></td><td><code>number</code></td><td>Per-job deadline from submission (ms). Overrides <code>taskTimeout</code>. Rejects with <code>TaskTimeoutError</code>.</td></tr>
      <tr><td><code>transfer</code></td><td><code>Transferable[]</code></td><td>Explicit transfer list for <code>postMessage</code>.</td></tr>
    </tbody>
  </table>

  <h2>RuntimeStats</h2>
  ${codeBlock(`interface RuntimeStats {
  workers: number;
  busyWorkers: number;
  idleWorkers: number;
  queuedJobs: number;
  runningJobs: number;
  completedJobs: number;
  failedJobs: number;
  averageWaitTime: number;
  averageExecutionTime: number;
}`)}

  <h2>Errors</h2>
  <table>
    <thead><tr><th>Class</th><th>When</th></tr></thead>
    <tbody>
      <tr><td><code>RuntimeError</code></td><td>Base class for AhWork errors.</td></tr>
      <tr><td><code>AbortError</code></td><td>Job cancelled via <code>AbortSignal</code>. Native reason in <code>cause</code>.</td></tr>
      <tr><td><code>TaskTimeoutError</code></td><td>Job exceeded its timeout.</td></tr>
      <tr><td><code>WorkerCrashedError</code></td><td>Worker died or became unusable.</td></tr>
      <tr><td><code>RuntimeShutdownError</code></td><td>Task invoked after <code>shutdown()</code>, or queued job dropped on shutdown.</td></tr>
    </tbody>
  </table>

  <h2>Exports</h2>
  ${codeBlock(`export { createRuntime } from "ahwork";
export type {
  Runtime,
  RuntimeOptions,
  RuntimeTask,
  RunOptions,
  MapInput,
  RuntimeStats,
  ShutdownOptions,
  TaskOptions,
};
export {
  RuntimeError,
  AbortError,
  TaskTimeoutError,
  WorkerCrashedError,
  RuntimeShutdownError,
};`)}
  `,
);
