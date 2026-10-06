import { assertNever, type WorkerToMain } from "../protocol/messages";
import type { Job } from "../scheduler/Job";
import { WorkerCrashedError } from "../errors/WorkerCrashedError";
import { RuntimeError } from "../errors/RuntimeError";
import { now } from "../utils/timing";

/** Lifecycle state of a managed worker. */
export type WorkerState = "idle" | "busy" | "terminated";

/** Callbacks the pool/scheduler uses to react to a worker's lifecycle. */
export interface ManagedWorkerCallbacks {
  onSettled: (worker: ManagedWorker) => void;
  onCrashed: (worker: ManagedWorker, error: Error) => void;
}

/** Everything a worker needs to register a task on first use. */
export interface TaskRegistration {
  source: string;
  hasContext: boolean;
  context?: unknown;
  /** Named helper functions (source text) to define in the worker scope. */
  inject?: Record<string, string>;
}

/** Resolves a task's registration payload by its id. */
export type ResolveRegistration = (taskId: string) => TaskRegistration;

const CLOSURE_HINT =
  "AhWork serializes tasks with fn.toString(), so closure/external variables are not available in the worker. Pass data via task(fn, { context }) and helper functions via task(fn, { inject }).";

/** Rebuild an Error-like object from the serialized worker error. */
function reconstructError(data: {
  name: string;
  message: string;
  stack?: string;
}): Error {
  const hinted =
    data.name === "ReferenceError" && !data.message.includes("fn.toString()")
      ? `${data.message}. ${CLOSURE_HINT}`
      : data.message;
  const error = new Error(hinted);
  error.name = data.name;
  if (data.stack) error.stack = data.stack;
  return error;
}

function isDataCloneError(cause: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" &&
      cause instanceof DOMException &&
      cause.name === "DataCloneError") ||
    (cause instanceof Error && cause.name === "DataCloneError")
  );
}

function toCloneError(cause: unknown): Error {
  const message =
    cause instanceof Error ? cause.message : "Value could not be cloned";
  const error = new Error(
    `${message}. Arguments, results and task context must be structured-clone compatible (no functions, DOM nodes, or class instances with methods).`,
  );
  error.name = "DataCloneError";
  if (cause instanceof Error) error.cause = cause;
  return error;
}

/**
 * Normalize an error thrown while dispatching a job. Only genuine
 * structured-clone failures are relabeled as DataCloneError; everything else
 * (e.g. an unknown-task RuntimeError from registration) is surfaced as-is.
 */
function toExecuteError(cause: unknown): Error {
  if (isDataCloneError(cause)) return toCloneError(cause);
  if (cause instanceof Error) return cause;
  return new RuntimeError(String(cause));
}

/**
 * Wraps a single Web Worker: handles message correlation, lazy task
 * registration and one in-flight job at a time.
 *
 * The worker realm and protocol are implementation details hidden behind this
 * class; the scheduler only calls {@link execute} and reacts to callbacks.
 */
export class ManagedWorker {
  state: WorkerState = "idle";
  currentJob: Job | null = null;
  lastUsedAt = now();
  readonly registeredTasks = new Set<string>();

  constructor(
    readonly id: string,
    private readonly worker: Worker,
    private readonly resolveRegistration: ResolveRegistration,
    private readonly callbacks: ManagedWorkerCallbacks,
  ) {
    this.worker.onmessage = (event: MessageEvent<WorkerToMain>) =>
      this.handleMessage(event.data);
    this.worker.onerror = (event: ErrorEvent) =>
      this.handleCrash(event.message);
    this.worker.onmessageerror = () =>
      this.handleCrash("Message could not be deserialized");
  }

  /** Assign and start a job on this worker. */
  execute(job: Job): void {
    this.state = "busy";
    this.currentJob = job;
    job.startedAt = now();

    // Lazy registration: send the source only the first time this worker
    // sees the task. Message ordering guarantees it is registered before EXECUTE.
    try {
      if (!this.registeredTasks.has(job.taskId)) {
        const registration = this.resolveRegistration(job.taskId);
        this.worker.postMessage({
          type: "REGISTER_TASK",
          taskId: job.taskId,
          source: registration.source,
          hasContext: registration.hasContext,
          context: registration.context,
          inject: registration.inject,
        });
        // Mark as registered only after the worker has actually received it, so
        // a failed REGISTER (e.g. non-cloneable context) does not corrupt state.
        this.registeredTasks.add(job.taskId);
      }

      const message = {
        type: "EXECUTE" as const,
        jobId: job.id,
        taskId: job.taskId,
        args: job.args,
      };
      if (job.transfer && job.transfer.length > 0) {
        this.worker.postMessage(message, job.transfer);
      } else {
        this.worker.postMessage(message);
      }
    } catch (cause) {
      this.currentJob = null;
      this.state = "idle";
      job.reject(toExecuteError(cause));
      this.settle();
    }
  }

  /**
   * Drop a task registration from this worker (and its cached context),
   * reclaiming worker-side memory. Safe to call at any time.
   */
  unregister(taskId: string): void {
    if (!this.registeredTasks.delete(taskId)) return;
    if (this.state === "terminated") return;
    try {
      this.worker.postMessage({ type: "UNREGISTER_TASK", taskId });
    } catch {
      // The task is already dropped locally; worker memory is reclaimed anyway.
    }
  }

  /** Permanently stop this worker and detach listeners. */
  terminate(): void {
    this.state = "terminated";
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.onmessageerror = null;
    this.worker.terminate();
  }

  private handleMessage(message: WorkerToMain): void {
    switch (message.type) {
      case "TASK_REGISTERED":
        return;
      case "TASK_RESULT": {
        const job = this.takeJob(message.jobId);
        job?.resolve(message.result);
        this.settle();
        return;
      }
      case "TASK_ERROR": {
        const job = this.takeJob(message.jobId);
        job?.reject(reconstructError(message.error));
        this.settle();
        return;
      }
      default:
        assertNever(message);
    }
  }

  private takeJob(jobId: string): Job | null {
    const job = this.currentJob;
    if (!job || job.id !== jobId) return null;
    this.currentJob = null;
    return job;
  }

  private settle(): void {
    if (this.state === "terminated") return;
    this.state = "idle";
    this.lastUsedAt = now();
    this.callbacks.onSettled(this);
  }

  private handleCrash(message: string): void {
    const error = new WorkerCrashedError(message || "Worker crashed");
    const job = this.currentJob;
    this.currentJob = null;
    job?.reject(error);
    this.state = "terminated";
    this.callbacks.onCrashed(this, error);
  }
}
