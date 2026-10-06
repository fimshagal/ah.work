/**
 * Public type surface for AhWork.
 *
 * These types define the contract of the library and are intentionally
 * decoupled from any Web Worker implementation detail.
 */

/** Options accepted by {@link createRuntime}. */
export interface RuntimeOptions {
  /** Minimum number of warm workers to keep alive. Default: `0`. */
  minWorkers?: number;
  /**
   * Maximum number of concurrent workers.
   * `"auto"` resolves to `navigator.hardwareConcurrency || 4`. Default: `"auto"`.
   */
  maxWorkers?: number | "auto";
  /** Idle time (ms) after which an idle worker is terminated. Default: `10_000`. */
  idleTimeout?: number;
  /** Default per-task timeout (ms). `0` means no timeout. Default: `0`. */
  taskTimeout?: number;
  /**
   * Max number of jobs allowed to wait in the queue (backpressure). When the
   * pool is saturated and the queue is full, further submissions reject with a
   * `QueueFullError`. `0` means unbounded. Default: `0`.
   */
  maxQueue?: number;

  // --- Extension points (typed now, implemented later) ---
  // /** Use a statically hosted worker entry (for strict-CSP sites). */
  // workerUrl?: string;
  // /** Provide an alternative worker backend (Node, Deno, module workers...). */
  // backend?: WorkerBackend;
}

/** Per-invocation execution options. */
export interface RunOptions {
  /** Cancel the job via a standard AbortSignal. */
  signal?: AbortSignal;
  /** Per-job timeout (ms). Overrides {@link RuntimeOptions.taskTimeout}. */
  timeout?: number;
  /** Explicit list of Transferable objects to move (zero-copy) into the worker. */
  transfer?: Transferable[];
}

/**
 * Input shape for {@link RuntimeTask.map}.
 *
 * - single-argument task (`[S]`)  -> `S[]`          e.g. `square.map([1, 2, 3])`
 * - multi-argument task (`[A, B]`) -> `[A, B][]`     e.g. `add.map([[1, 2], [3, 4]])`
 */
export type MapInput<A extends unknown[]> = A extends [infer S] ? S[] : A[];

/** A task created via {@link Runtime.task}. Callable like a normal async function. */
export interface RuntimeTask<A extends unknown[], R> {
  /** Simple call form: behaves like an async version of the original function. */
  (...args: A): Promise<Awaited<R>>;
  /** Extended call form with execution options (cancellation, timeout, transfer). */
  run(args: A, options?: RunOptions): Promise<Awaited<R>>;
  /** Run the task across many inputs; results preserve input order. */
  map(inputs: MapInput<A>, options?: RunOptions): Promise<Awaited<R>[]>;
  /**
   * Drop this task's registration from the runtime and from every worker,
   * reclaiming the memory held by its serialized source and cached context.
   * Calling the task after `dispose()` rejects with a `RuntimeError`.
   */
  dispose(): void;
}

/** Snapshot of runtime activity returned by {@link Runtime.stats}. */
export interface RuntimeStats {
  workers: number;
  busyWorkers: number;
  idleWorkers: number;
  queuedJobs: number;
  runningJobs: number;
  completedJobs: number;
  failedJobs: number;
  averageWaitTime: number;
  averageExecutionTime: number;
}

/** Options for {@link Runtime.shutdown}. */
export interface ShutdownOptions {
  /** Wait for currently running jobs to finish before terminating workers. */
  graceful?: boolean;
  /**
   * Max time (ms) to wait for running jobs during a graceful shutdown. When it
   * elapses, still-running jobs are force-rejected and workers terminated.
   * Only meaningful together with `graceful: true`. `0`/unset = wait forever.
   */
  timeout?: number;
}

/** Options for {@link Runtime.task}. */
export interface TaskOptions<C> {
  /**
   * Serializable data injected into the worker as the task's last argument.
   *
   * This is the supported way to pass external/closure values (which
   * `fn.toString()` cannot capture). The value must be structured-clone
   * compatible; it is sent once per worker and cached there.
   */
  context: C;
}

/** The main entry object created by {@link createRuntime}. */
export interface Runtime {
  /** Register a function as a task and return a callable task handle. */
  task<A extends unknown[], R>(fn: (...args: A) => R): RuntimeTask<A, R>;
  /**
   * Register a task whose function receives an injected `context` as its last
   * argument. The returned task is called with the remaining arguments only.
   */
  task<A extends unknown[], C, R>(
    fn: (...args: [...A, C]) => R,
    options: TaskOptions<C>,
  ): RuntimeTask<A, R>;
  /** Return a lightweight snapshot of current runtime statistics. */
  stats(): RuntimeStats;
  /** Terminate workers and release all resources. */
  shutdown(options?: ShutdownOptions): Promise<void>;
}
