import type {
  InjectMap,
  InjectOptions,
  RunOptions,
  Runtime,
  RuntimeOptions,
  RuntimeStats,
  RuntimeTask,
  ShutdownOptions,
  TaskOptions,
} from "../types";
import type { Job } from "../scheduler/Job";
import type { TaskRegistration } from "../workers/WorkerInstance";
import { Scheduler } from "../scheduler/Scheduler";
import { WorkerFactory } from "../workers/WorkerFactory";
import { RuntimeError } from "../errors/RuntimeError";
import { RuntimeShutdownError } from "../errors/RuntimeShutdownError";
import { TaskTimeoutError } from "../errors/TaskTimeoutError";
import { AbortError } from "../errors/AbortError";
import { QueueFullError } from "../errors/QueueFullError";
import { WorkerCrashedError } from "../errors/WorkerCrashedError";
import { WorkerSpawnError } from "../errors/WorkerSpawnError";
import { detectTransferables } from "../utils/transferables";
import { createIdGenerator } from "../utils/ids";
import { RunningAverage, now } from "../utils/timing";
import { createRuntimeTask, type SubmitFn } from "./RuntimeTask";

/** Resolved, normalized runtime configuration. */
interface ResolvedOptions {
  minWorkers: number;
  maxWorkers: number;
  idleTimeout: number;
  taskTimeout: number;
  maxQueue: number;
  retries: number;
  autoTransfer: boolean;
  workerUrl?: string;
}

/** Valid JS identifier (so injected helper names are safe to splice into source). */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** Every identifier-shaped token in a chunk of source text. */
const IDENTIFIER_TOKEN = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/** The set of identifiers that appear anywhere in `text` (strings included). */
function identifiersIn(text: string): Set<string> {
  return new Set(text.match(IDENTIFIER_TOKEN) ?? []);
}

/**
 * Turn a map of helper functions into a name -> source-text map.
 *
 * Beyond validating the keys, this guards the one way `inject` can fail
 * silently. A task body travels as **text** while inject keys travel as
 * **data**, and a minifier rewrites the former but not the latter: pass an
 * existing function by shorthand (`inject: { astar }`) and the shipped task
 * body may call `xt(...)` while the key is still `"astar"`. Two defences:
 *
 *  1. every helper is published under its own `fn.name` as well, which a
 *     minifier renames in lockstep with the call site, so the task finds it;
 *  2. a helper that no reachable source text mentions by any of its names is
 *     rejected here and now. Helpers exist as `var`s inside the generated
 *     worker function, so a literal reference is the only way to reach one —
 *     an unmentioned helper is provably uncallable, and would otherwise become
 *     a `ReferenceError` inside the worker in production builds only.
 */
function serializeInject(
  inject: InjectMap | undefined,
  taskSource: string,
): Record<string, string> | undefined {
  if (!inject) return undefined;
  const entries = Object.entries(inject);
  if (entries.length === 0) return undefined;

  const out: Record<string, string> = {};
  for (const [name, fn] of entries) {
    if (!IDENTIFIER.test(name)) {
      throw new RuntimeError(
        `Invalid inject helper name: "${name}". Names must be valid JavaScript identifiers.`,
      );
    }
    if (typeof fn !== "function") {
      throw new RuntimeError(
        `Invalid inject helper "${name}": expected a function, got ${typeof fn}.`,
      );
    }
    out[name] = fn.toString();
  }

  // (1) Alias each helper to its runtime name, which survives minification
  // together with the call site. Never clobber a name the caller chose.
  const aliases: Record<string, string> = {};
  for (const [name, fn] of entries) {
    const runtimeName = fn.name;
    if (!runtimeName || runtimeName === name) continue;
    if (!IDENTIFIER.test(runtimeName)) continue;
    if (runtimeName in out || runtimeName in aliases) continue;
    aliases[runtimeName] = out[name];
  }
  Object.assign(out, aliases);

  // (2) A helper is reachable only if the task, or some *other* helper, names
  // it. Its own source does not count: self-reference cannot make it callable.
  const taskTokens = identifiersIn(taskSource);
  const helperTokens = entries.map(([name]) => identifiersIn(out[name]));
  for (let i = 0; i < entries.length; i++) {
    const [name, fn] = entries[i];
    const runtimeName = fn.name;
    const names = runtimeName && runtimeName !== name ? [name, runtimeName] : [name];

    let reachable = names.some((n) => taskTokens.has(n));
    for (let j = 0; !reachable && j < helperTokens.length; j++) {
      if (j !== i) reachable = names.some((n) => helperTokens[j].has(n));
    }
    if (reachable) continue;

    throw new RuntimeError(
      `Injected helper "${name}" is never referenced by the task or by another helper, ` +
        `so the worker could never call it. If this task is going through a minifier, ` +
        `the call site inside the task body was renamed but the inject key was not: ` +
        `write the helper inline in the inject object, or nest it inside the task.`,
    );
  }

  return out;
}

/** Coerce a user-supplied number to a finite, non-negative integer. */
function toNonNegativeInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

/** Resolve when `promise` settles or after `ms`, whichever comes first. */
function raceWithTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    void promise.then(finish);
  });
}

/** Wrap an aborted signal's reason into an AbortError, preserving the cause. */
function toAbortError(signal: AbortSignal): AbortError {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) {
    return new AbortError(reason.message, { cause: reason });
  }
  return reason === undefined
    ? new AbortError()
    : new AbortError("The operation was aborted", { cause: reason });
}

/** @internal Exported for tests; normalizes/validates user options. */
export function resolveOptions(options: RuntimeOptions): ResolvedOptions {
  const hardwareConcurrency =
    typeof navigator !== "undefined" && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4;

  const rawMax =
    options.maxWorkers === undefined || options.maxWorkers === "auto"
      ? hardwareConcurrency
      : options.maxWorkers;
  // At least one worker, always a finite integer.
  const maxWorkers = Math.max(1, toNonNegativeInt(rawMax, hardwareConcurrency));
  // minWorkers is clamped into [0, maxWorkers] so the pool never contradicts itself.
  const minWorkers = Math.min(
    maxWorkers,
    toNonNegativeInt(options.minWorkers, 0),
  );

  return {
    minWorkers,
    maxWorkers,
    idleTimeout: toNonNegativeInt(options.idleTimeout, 10_000),
    taskTimeout: toNonNegativeInt(options.taskTimeout, 0),
    maxQueue: toNonNegativeInt(options.maxQueue, 0),
    retries: toNonNegativeInt(options.retries, 0),
    autoTransfer: options.autoTransfer === true,
    workerUrl: options.workerUrl,
  };
}

/**
 * Concrete Runtime implementation.
 *
 * Wires factory -> scheduler -> pool and exposes the task-oriented public API.
 * Implemented (phases 1-5): dynamic worker creation, protocol, task registry,
 * job/promise correlation, worker reuse, on-demand scaling up to maxWorkers,
 * minWorkers prewarming, idle-timeout termination, map(), per-job timeouts and
 * AbortSignal cancellation.
 *
 * Automatic transferable detection is left for a later phase (explicit
 * `transfer` lists already work).
 */
export class AhWorkRuntime implements Runtime {
  private readonly options: ResolvedOptions;
  private readonly factory: WorkerFactory;
  private readonly scheduler: Scheduler;
  private readonly nextTaskId = createIdGenerator("task");
  private readonly nextJobId = createIdGenerator("job");
  private readonly tasks = new Map<string, TaskRegistration>();
  private isShutDown = false;
  private shutdownPromise: Promise<void> | null = null;

  private completedJobs = 0;
  private failedJobs = 0;
  private readonly waitTime = new RunningAverage();
  private readonly executionTime = new RunningAverage();

  constructor(options: RuntimeOptions = {}) {
    this.options = resolveOptions(options);
    this.factory = new WorkerFactory(this.options.workerUrl);
    this.scheduler = new Scheduler(
      this.factory,
      {
        minWorkers: this.options.minWorkers,
        maxWorkers: this.options.maxWorkers,
        idleTimeout: this.options.idleTimeout,
        maxQueue: this.options.maxQueue,
      },
      (taskId) => this.getTaskRegistration(taskId),
    );
  }

  task<A extends unknown[], R>(fn: (...args: A) => R): RuntimeTask<A, R>;
  task<A extends unknown[], C, R>(
    fn: (...args: [...A, C]) => R,
    options: TaskOptions<C>,
  ): RuntimeTask<A, R>;
  task<A extends unknown[], R>(
    fn: (...args: A) => R,
    options: InjectOptions,
  ): RuntimeTask<A, R>;
  // Implementation signature: broad on purpose so every overload is compatible.
  task(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fn: (...args: any[]) => any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: TaskOptions<any> | InjectOptions,
  ): RuntimeTask<unknown[], unknown> {
    const taskId = this.nextTaskId();
    const hasContext = options !== undefined && "context" in options;
    const source = fn.toString();

    this.tasks.set(taskId, {
      source,
      hasContext,
      context: hasContext ? (options as TaskOptions<unknown>).context : undefined,
      inject: serializeInject(options?.inject, source),
    });

    // Declared callable arity (excluding an injected context), used by map().
    const argCount = Math.max(0, fn.length - (hasContext ? 1 : 0));

    const submit: SubmitFn<unknown[], unknown> = (args, runOptions) =>
      this.submitJob<unknown>(taskId, args, runOptions);

    const dispose = () => this.disposeTask(taskId);

    return createRuntimeTask<unknown[], unknown>(submit, argCount, dispose);
  }

  private disposeTask(taskId: string): void {
    if (!this.tasks.delete(taskId)) return;
    if (!this.isShutDown) this.scheduler.unregisterTask(taskId);
  }

  stats(): RuntimeStats {
    return {
      workers: this.scheduler.workerCount,
      busyWorkers: this.scheduler.busyWorkers,
      idleWorkers: this.scheduler.idleWorkers,
      queuedJobs: this.scheduler.queuedJobs,
      runningJobs: this.scheduler.busyWorkers,
      completedJobs: this.completedJobs,
      failedJobs: this.failedJobs,
      averageWaitTime: this.waitTime.value,
      averageExecutionTime: this.executionTime.value,
    };
  }

  /**
   * Shut the runtime down. Idempotent: the **first** call decides the mode and
   * every call returns the same promise.
   *
   * Escalation: if a graceful shutdown is already in progress and a later call
   * requests an immediate shutdown (`shutdown()` or `shutdown({ graceful: false })`),
   * the still-running jobs are force-rejected right away instead of being waited
   * on. Options on later graceful calls are otherwise ignored.
   */
  async shutdown(options?: ShutdownOptions): Promise<void> {
    if (this.shutdownPromise) {
      const wantsImmediate = options === undefined || options.graceful !== true;
      if (wantsImmediate) {
        this.scheduler.rejectRunning(
          new RuntimeShutdownError("Runtime shutdown escalated to immediate"),
        );
      }
      return this.shutdownPromise;
    }
    this.shutdownPromise = this.performShutdown(options);
    return this.shutdownPromise;
  }

  private async performShutdown(options?: ShutdownOptions): Promise<void> {
    this.isShutDown = true;

    for (const job of this.scheduler.drainQueue()) {
      job.reject(
        new RuntimeShutdownError("Runtime was shut down before the job started"),
      );
    }

    if (options?.graceful) {
      const done = this.scheduler.whenRunningDone();
      const timeout = options.timeout ?? 0;
      if (timeout > 0) {
        await raceWithTimeout(done, timeout);
        // If the deadline won, force-reject whatever is still running.
        this.scheduler.rejectRunning(
          new RuntimeShutdownError(
            "Graceful shutdown timed out before running jobs finished",
          ),
        );
      } else {
        await done;
      }
    } else {
      this.scheduler.rejectRunning(
        new RuntimeShutdownError("Runtime was shut down"),
      );
    }

    this.scheduler.dispose();
    this.tasks.clear();
  }

  private getTaskRegistration(taskId: string): TaskRegistration {
    const registration = this.tasks.get(taskId);
    if (registration === undefined) {
      throw new RuntimeError(`Unknown task for id: ${taskId}`);
    }
    return registration;
  }

  /** Merge explicit and auto-detected transferables for a job. */
  private resolveTransfer(
    args: unknown[],
    options?: RunOptions,
  ): Transferable[] | undefined {
    const explicit = options?.transfer;
    const auto = options?.autoTransfer ?? this.options.autoTransfer;
    if (!auto) return explicit;
    const set = new Set<Transferable>(explicit ?? []);
    for (const t of detectTransferables(args)) set.add(t);
    return set.size > 0 ? [...set] : undefined;
  }

  private submitJob<R>(
    taskId: string,
    args: unknown[],
    options?: RunOptions,
  ): Promise<Awaited<R>> {
    if (this.isShutDown) {
      return Promise.reject(new RuntimeShutdownError());
    }

    if (!this.tasks.has(taskId)) {
      return Promise.reject(
        new RuntimeError("Task has been disposed and can no longer be called"),
      );
    }

    const signal = options?.signal;
    // Timeout deadline spans all retry attempts (measured from first submission).
    const timeout = options?.timeout ?? this.options.taskTimeout;
    const maxRetries = options?.retries ?? this.options.retries;
    const transfer = this.resolveTransfer(args, options);

    return new Promise<Awaited<R>>((resolve, reject) => {
      let settled = false;
      let attempts = 0;
      let currentJobId: string | undefined;
      // Set by timeout/abort to veto any further retries.
      let terminalError: Error | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;

      const cleanup = () => {
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      };

      const finalize = (settle: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        settle();
      };

      const onResult = (job: Job, value: unknown): void => {
        finalize(() => {
          this.completedJobs += 1;
          this.recordTiming(job);
          resolve(value as Awaited<R>);
        });
      };

      const onError = (job: Job, error: Error): void => {
        if (settled) return;
        const retryable =
          terminalError === undefined &&
          attempts < maxRetries &&
          (error instanceof WorkerCrashedError ||
            error instanceof WorkerSpawnError);
        if (retryable) {
          attempts += 1;
          startAttempt();
          return;
        }
        finalize(() => {
          this.failedJobs += 1;
          this.recordTiming(job);
          reject(error);
        });
      };

      const startAttempt = (): void => {
        const jobId = this.nextJobId();
        currentJobId = jobId;
        const job: Job = {
          id: jobId,
          taskId,
          args,
          createdAt: now(),
          transfer,
          resolve: (value) => onResult(job, value),
          reject: (error) => onError(job, error),
        };
        // Backpressure: a full queue rejects the job instead of growing unbounded.
        if (!this.scheduler.submit(job)) {
          onError(job, new QueueFullError());
        }
      };

      // Cancel the in-flight attempt with a terminal (non-retryable) error.
      const cancelTerminal = (error: Error): void => {
        terminalError = error;
        if (currentJobId !== undefined) {
          this.scheduler.cancelJob(currentJobId, error);
        }
      };

      // Already aborted before we start: reject without ever scheduling.
      if (signal?.aborted) {
        finalize(() => {
          this.failedJobs += 1;
          reject(toAbortError(signal));
        });
        return;
      }

      // Per-job timeout (deadline measured from first submission). 0 = none.
      if (timeout > 0) {
        timeoutTimer = setTimeout(() => {
          cancelTerminal(
            new TaskTimeoutError(`Task exceeded timeout of ${timeout}ms`),
          );
        }, timeout);
      }

      // AbortSignal cancellation.
      if (signal) {
        onAbort = () => cancelTerminal(toAbortError(signal));
        signal.addEventListener("abort", onAbort, { once: true });
      }

      startAttempt();
    });
  }

  private recordTiming(job: Job): void {
    // Only jobs that actually started contribute to timing stats. Jobs rejected
    // while still queued (shutdown, abort/timeout before dispatch, queue-full)
    // have no meaningful wait/execution time and would otherwise skew averages.
    if (job.startedAt === undefined) return;
    this.waitTime.add(job.startedAt - job.createdAt);
    this.executionTime.add(now() - job.startedAt);
  }
}
