import type {
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
  private readonly factory = new WorkerFactory();
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
  // Implementation signature: broad on purpose so both overloads are compatible.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  task(fn: (...args: any[]) => any, options?: TaskOptions<any>): RuntimeTask<any, any> {
    const taskId = this.nextTaskId();
    const hasContext = options !== undefined;
    this.tasks.set(taskId, {
      source: fn.toString(),
      hasContext,
      context: options?.context,
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
    const timeout = options?.timeout ?? this.options.taskTimeout;

    return new Promise<Awaited<R>>((resolve, reject) => {
      const jobId = this.nextJobId();
      let settled = false;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;

      const cleanup = () => {
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      };

      const job: Job = {
        id: jobId,
        taskId,
        args,
        createdAt: now(),
        signal,
        timeout,
        transfer: options?.transfer,
        resolve: (value) => {
          if (settled) return;
          settled = true;
          cleanup();
          this.completedJobs += 1;
          this.recordTiming(job);
          resolve(value as Awaited<R>);
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          this.failedJobs += 1;
          this.recordTiming(job);
          reject(error);
        },
      };

      // Already aborted before we start: reject without ever scheduling.
      if (signal?.aborted) {
        job.reject(toAbortError(signal));
        return;
      }

      // Per-job timeout (deadline measured from submission). 0 = no timeout.
      if (timeout > 0) {
        timeoutTimer = setTimeout(() => {
          this.scheduler.cancelJob(
            jobId,
            new TaskTimeoutError(`Task exceeded timeout of ${timeout}ms`),
          );
        }, timeout);
      }

      // AbortSignal cancellation.
      if (signal) {
        onAbort = () => {
          this.scheduler.cancelJob(jobId, toAbortError(signal));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }

      // Backpressure: a full queue rejects the job instead of growing unbounded.
      if (!this.scheduler.submit(job)) {
        job.reject(new QueueFullError());
      }
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
