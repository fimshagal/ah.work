/**
 * Public type surface for AhWork.
 *
 * These types define the contract of the library and are intentionally
 * decoupled from any Web Worker implementation detail.
 */

/**
 * A value that can be *moved* into a worker instead of copied.
 *
 * Deliberately not the DOM's `Transferable`: these types ship in the Node build
 * too, where `lib.dom` is absent, and the transferable set differs per platform
 * anyway (DOM `Transferable` vs Node `TransferListItem`). `ArrayBuffer` and
 * `MessagePort` are the portable members; everything else depends on the host.
 */
export type TransferableValue = object;

/** Behaviour of a saturated queue — see {@link RuntimeOptions.onQueueFull}. */
export type QueueFullPolicy = "reject" | "evict-lowest";

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
  /**
   * What happens when the queue is at `maxQueue` and another job arrives.
   *
   * - `"reject"` (default): the newcomer rejects with `QueueFullError`.
   * - `"evict-lowest"`: if the newcomer **outranks** the weakest queued job,
   *   that job is dropped (it rejects with `QueueFullError`) and the newcomer
   *   takes its slot. A job that does not outrank it is rejected as usual.
   *
   * Only meaningful together with `maxQueue` and per-job `priority`.
   */
  onQueueFull?: QueueFullPolicy;
  /**
   * Starvation guard for priorities: every `fairness`-th dispatch ignores
   * priority and takes the **oldest** waiting job instead. `0` disables it
   * (strict priority, low-priority work may never run under sustained load).
   * Has no observable effect unless jobs use different priorities.
   * Default: `4`.
   */
  fairness?: number;
  /**
   * Default number of automatic retries for jobs that fail due to worker
   * *infrastructure* errors (`WorkerCrashedError`, `WorkerSpawnError`). Task
   * errors, timeouts and aborts are never retried. Default: `0`.
   */
  retries?: number;
  /**
   * Automatically detect Transferable objects (ArrayBuffers, typed-array
   * buffers, MessagePorts, streams, ImageBitmap, OffscreenCanvas) in task
   * arguments and move them zero-copy. NOTE: transferring *detaches* the buffer
   * on the main thread. Default: `false`. Can be overridden per call.
   */
  autoTransfer?: boolean;
  /**
   * Use a statically hosted worker entry instead of a `blob:` URL (for sites
   * with a strict Content-Security-Policy that blocks blob workers). The hosted
   * file must contain AhWork's worker source — see the `workerSourceCode` export.
   */
  workerUrl?: string;
}

/** Per-invocation execution options. */
export interface RunOptions {
  /** Cancel the job via a standard AbortSignal. */
  signal?: AbortSignal;
  /** Per-job timeout (ms). Overrides {@link RuntimeOptions.taskTimeout}. */
  timeout?: number;
  /** Explicit list of transferable objects to move (zero-copy) into the worker. */
  transfer?: TransferableValue[];
  /**
   * Auto-detect transferables in the arguments (merged with any explicit
   * `transfer`). Overrides {@link RuntimeOptions.autoTransfer} for this call.
   */
  autoTransfer?: boolean;
  /**
   * Number of automatic retries on worker infrastructure errors for this call.
   * Overrides {@link RuntimeOptions.retries}.
   */
  retries?: number;
  /**
   * Scheduling priority: **higher runs sooner**. Default: `0`.
   *
   * Order within one priority level stays strictly FIFO. Note that priority
   * only has an effect while the pool is saturated *and* jobs are actually
   * waiting — with enough workers the queue is usually empty and this is a
   * no-op. It buys predictability under overload, not speed.
   */
  priority?: number;
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

/**
 * A set of named helper functions made available (by name) inside the worker
 * scope, so the task body can call them. Each helper is serialized with
 * `fn.toString()` — exactly like the task itself — so it must be **self
 * contained** (no closure/external variables of its own). Helpers may call one
 * another. Keys must be valid JavaScript identifiers.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type InjectMap = Record<string, (...args: any[]) => any>;

/** Options for {@link Runtime.task} (with an injected `context`). */
export interface TaskOptions<C> {
  /**
   * Serializable data injected into the worker as the task's last argument.
   *
   * This is the supported way to pass external/closure values (which
   * `fn.toString()` cannot capture). The value must be structured-clone
   * compatible; it is sent once per worker and cached there.
   */
  context: C;
  /**
   * Helper functions made available by name inside the worker. See {@link InjectMap}.
   */
  inject?: InjectMap;
}

/** Options for {@link Runtime.task} when only helper functions are injected. */
export interface InjectOptions {
  /** Helper functions made available by name inside the worker. */
  inject: InjectMap;
  /** Not allowed here — use {@link TaskOptions} when you also need a context. */
  context?: never;
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
  /**
   * Register a task with injected helper functions but no `context`. The task
   * is called with its normal arguments; helpers are reachable by name.
   */
  task<A extends unknown[], R>(
    fn: (...args: A) => R,
    options: InjectOptions,
  ): RuntimeTask<A, R>;
  /** Return a lightweight snapshot of current runtime statistics. */
  stats(): RuntimeStats;
  /** Terminate workers and release all resources. */
  shutdown(options?: ShutdownOptions): Promise<void>;
}
