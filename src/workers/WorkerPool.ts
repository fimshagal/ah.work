import type { WorkerFactory } from "./WorkerFactory";
import {
  ManagedWorker,
  type ManagedWorkerCallbacks,
  type ResolveRegistration,
} from "./WorkerInstance";
import { createIdGenerator } from "../utils/ids";
import { WorkerSpawnError } from "../errors/WorkerSpawnError";

export interface WorkerPoolOptions {
  minWorkers: number;
  maxWorkers: number;
  /** Idle time (ms) before an idle worker is terminated. `<= 0` disables it. */
  idleTimeout: number;
}

/**
 * Owns and tracks all worker instances and the auto-scaling policy.
 *
 * Scaling up: workers are spawned on demand up to `maxWorkers`.
 * Scaling down: each idle worker arms a per-worker timer (no polling); when it
 * fires, the worker is terminated only if the pool stays at or above
 * `minWorkers`. Busy workers are never terminated.
 *
 * Membership is tracked in O(1) auxiliary structures: `idle`/`busy` sets back
 * the stat getters and `findIdle`, and a `jobId -> worker` index backs
 * `findByJob`, so none of the hot paths scan the whole pool.
 */
export class WorkerPool {
  private readonly workers = new Set<ManagedWorker>();
  private readonly idle = new Set<ManagedWorker>();
  private readonly busy = new Set<ManagedWorker>();
  private readonly jobIndex = new Map<string, ManagedWorker>();
  private readonly runningJob = new Map<ManagedWorker, string>();
  private readonly idleTimers = new Map<
    ManagedWorker,
    ReturnType<typeof setTimeout>
  >();
  private readonly nextWorkerId = createIdGenerator("worker");

  constructor(
    private readonly factory: WorkerFactory,
    private readonly options: WorkerPoolOptions,
    private readonly resolveRegistration: ResolveRegistration,
    private readonly callbacks: ManagedWorkerCallbacks,
  ) {}

  get size(): number {
    return this.workers.size;
  }

  get idleCount(): number {
    return this.idle.size;
  }

  get busyCount(): number {
    return this.busy.size;
  }

  canSpawn(): boolean {
    return this.workers.size < this.options.maxWorkers;
  }

  findIdle(): ManagedWorker | undefined {
    for (const worker of this.idle) return worker;
    return undefined;
  }

  /** Find the worker currently running the given job, if any. */
  findByJob(jobId: string): ManagedWorker | undefined {
    return this.jobIndex.get(jobId);
  }

  /**
   * Spawn a new worker. Throws {@link WorkerSpawnError} if the environment
   * refuses to create the worker (e.g. a strict CSP blocking blob: workers).
   */
  spawn(): ManagedWorker {
    let raw: Worker;
    try {
      raw = this.factory.create();
    } catch (cause) {
      throw new WorkerSpawnError(undefined, { cause });
    }
    const worker = new ManagedWorker(
      this.nextWorkerId(),
      raw,
      this.resolveRegistration,
      this.callbacks,
    );
    this.workers.add(worker);
    this.idle.add(worker);
    return worker;
  }

  /** Ensure at least `minWorkers` exist (prewarming / post-crash refill). */
  ensureMinimum(): void {
    while (this.workers.size < this.options.minWorkers) {
      this.spawn();
    }
  }

  /** Mark a worker as taken: move it to the busy set and index its job. */
  markBusy(worker: ManagedWorker, jobId?: string): void {
    this.cancelIdleTimer(worker);
    this.idle.delete(worker);
    this.busy.add(worker);
    if (jobId !== undefined) {
      this.jobIndex.set(jobId, worker);
      this.runningJob.set(worker, jobId);
    }
  }

  /** Mark a worker as idle: drop its job index and arm its idle-termination timer. */
  markIdle(worker: ManagedWorker): void {
    this.clearJobIndex(worker);
    this.busy.delete(worker);
    this.idle.add(worker);
    this.cancelIdleTimer(worker);
    if (this.options.idleTimeout <= 0) return;
    const timer = setTimeout(
      () => this.onIdleTimeout(worker),
      this.options.idleTimeout,
    );
    this.idleTimers.set(worker, timer);
  }

  remove(worker: ManagedWorker): void {
    this.cancelIdleTimer(worker);
    this.clearJobIndex(worker);
    this.idle.delete(worker);
    this.busy.delete(worker);
    this.workers.delete(worker);
  }

  /**
   * Reject every in-flight job and terminate its worker immediately (immediate
   * shutdown / graceful-timeout escalation).
   *
   * Terminating here (rather than deferring to {@link dispose}) closes the small
   * window in which a worker could still deliver a late TASK_RESULT/TASK_ERROR
   * after its job has already been rejected. Idle workers are left for dispose.
   */
  rejectRunning(error: Error): void {
    for (const worker of [...this.workers]) {
      const job = worker.currentJob;
      if (!job) continue;
      worker.currentJob = null;
      job.reject(error);
      worker.terminate();
      this.remove(worker);
    }
  }

  /** Terminate every worker, clear timers and release the shared blob URL. */
  dispose(): void {
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    for (const worker of this.workers) worker.terminate();
    this.workers.clear();
    this.idle.clear();
    this.busy.clear();
    this.jobIndex.clear();
    this.runningJob.clear();
    this.factory.dispose();
  }

  /** Broadcast a task unregistration to every worker that holds it. */
  unregisterTask(taskId: string): void {
    for (const worker of this.workers) worker.unregister(taskId);
  }

  private clearJobIndex(worker: ManagedWorker): void {
    const jobId = this.runningJob.get(worker);
    if (jobId !== undefined) {
      this.jobIndex.delete(jobId);
      this.runningJob.delete(worker);
    }
  }

  private cancelIdleTimer(worker: ManagedWorker): void {
    const timer = this.idleTimers.get(worker);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.idleTimers.delete(worker);
    }
  }

  private onIdleTimeout(worker: ManagedWorker): void {
    this.idleTimers.delete(worker);
    if (worker.state !== "idle") return; // became busy meanwhile
    if (this.workers.size <= this.options.minWorkers) return; // never below min
    worker.terminate();
    this.remove(worker);
  }
}
