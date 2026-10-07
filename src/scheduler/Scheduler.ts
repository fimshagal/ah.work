import { WorkerPool, type WorkerPoolOptions } from "../workers/WorkerPool";
import type { WorkerBackend } from "../workers/WorkerBackend";
import type {
  ManagedWorker,
  ResolveRegistration,
} from "../workers/WorkerInstance";
import { PriorityQueue } from "./PriorityQueue";
import type { Job } from "./Job";
import type { QueueFullPolicy } from "../types";
import { QueueFullError } from "../errors/QueueFullError";

/** Pool options plus the scheduler's own waiting-queue policy. */
export interface SchedulerOptions extends WorkerPoolOptions {
  /** Max waiting jobs before submissions are rejected. `<= 0` = unbounded. */
  maxQueue?: number;
  /** Every Nth dispatch ignores priority. `<= 0` = strict priority. */
  fairness?: number;
  /** What a full queue does when a higher-priority job arrives. */
  onQueueFull?: QueueFullPolicy;
}

/**
 * Assigns queued jobs to workers and reacts to completion / crashes.
 *
 * Owns the WorkerPool so wiring stays acyclic. Dispatch order is by priority
 * (FIFO within a level, see {@link PriorityQueue}), with on-demand worker
 * creation:
 *   - idle worker available -> assign
 *   - below maxWorkers      -> spawn and assign
 *   - otherwise             -> keep queued (up to maxQueue)
 *
 * Auto-scaling: prewarms `minWorkers` on creation, arms idle timers when a
 * worker stays idle after dispatch, and refills to `minWorkers` after a crash.
 */
export class Scheduler {
  private readonly pool: WorkerPool;
  private readonly queue: PriorityQueue;
  private readonly runningWaiters: Array<() => void> = [];
  private readonly maxQueue: number;
  private readonly onQueueFull: QueueFullPolicy;

  constructor(
    factory: WorkerBackend,
    options: SchedulerOptions,
    resolveRegistration: ResolveRegistration,
  ) {
    this.maxQueue = options.maxQueue ?? 0;
    this.onQueueFull = options.onQueueFull ?? "reject";
    this.queue = new PriorityQueue(options.fairness ?? 0);
    this.pool = new WorkerPool(factory, options, resolveRegistration, {
      onSettled: (worker) => this.handleSettled(worker),
      onCrashed: (worker) => this.handleCrash(worker),
    });
    this.pool.ensureMinimum(); // prewarm minWorkers
  }

  /**
   * Enqueue a job and try to dispatch it. Returns `false` (without enqueuing)
   * when the waiting queue is full and the job may not take anyone's slot; the
   * caller should reject.
   *
   * The queue only grows while the pool is fully saturated (dispatch always
   * drains to idle/newly-spawned workers first), so comparing against the queue
   * length is a precise backpressure signal.
   *
   * With `onQueueFull: "evict-lowest"` a job that **outranks** the weakest
   * queued one takes its place; the evicted job rejects with `QueueFullError`,
   * exactly like a refused submission, so callers need no new error type.
   */
  submit(job: Job): boolean {
    if (this.maxQueue > 0 && this.queue.size >= this.maxQueue) {
      if (this.onQueueFull !== "evict-lowest") return false;
      const victim = this.queue.evictLowerThan(job.priority ?? 0);
      if (!victim) return false;
      victim.reject(
        new QueueFullError(
          "Job was evicted from a full queue by a higher-priority job.",
        ),
      );
    }
    this.queue.enqueue(job);
    this.dispatch();
    return true;
  }

  get queuedJobs(): number {
    return this.queue.size;
  }

  get workerCount(): number {
    return this.pool.size;
  }

  get idleWorkers(): number {
    return this.pool.idleCount;
  }

  get busyWorkers(): number {
    return this.pool.busyCount;
  }

  /**
   * Cancel a job (timeout or abort). Returns true if the job was found.
   *   - queued  -> removed from the queue and rejected
   *   - running -> the executing worker is terminated, the job rejected, and a
   *                replacement spawned if queued work or minWorkers requires it
   *   - already finished -> no-op (returns false)
   */
  cancelJob(jobId: string, error: Error): boolean {
    const queued = this.queue.remove(jobId);
    if (queued) {
      queued.reject(error);
      return true;
    }

    const worker = this.pool.findByJob(jobId);
    if (worker) {
      const job = worker.currentJob;
      this.pool.remove(worker);
      worker.terminate();
      job?.reject(error);
      this.dispatch();
      this.pool.ensureMinimum();
      this.notifyRunningMaybeDone();
      return true;
    }

    return false;
  }

  /** Remove and return all still-queued jobs (used during shutdown). */
  drainQueue(): Job[] {
    return this.queue.drain();
  }

  /** Reject jobs that are already executing (immediate shutdown). */
  rejectRunning(error: Error): void {
    this.pool.rejectRunning(error);
    this.flushRunningWaiters();
  }

  /** Drop a task registration from every worker (task.dispose()). */
  unregisterTask(taskId: string): void {
    this.pool.unregisterTask(taskId);
  }

  /**
   * Resolve when no worker is busy. Used by graceful shutdown after the queue
   * has been drained so remaining work is only in-flight jobs.
   */
  whenRunningDone(): Promise<void> {
    if (this.pool.busyCount === 0) return Promise.resolve();
    return new Promise((resolve) => this.runningWaiters.push(resolve));
  }

  dispose(): void {
    this.pool.dispose();
    this.flushRunningWaiters();
  }

  private handleSettled(worker: ManagedWorker): void {
    // Return the worker to the idle set *before* dispatch so queued work can
    // reuse it immediately (findIdle must see it).
    if (worker.state === "idle") this.pool.markIdle(worker);
    this.dispatch();
    this.notifyRunningMaybeDone();
  }

  private handleCrash(worker: ManagedWorker): void {
    this.pool.remove(worker);
    worker.terminate();
    // Replace: queued work gets a new worker via dispatch(); empty pool is
    // topped up to minWorkers so a crash never leaves the runtime stranded.
    this.dispatch();
    this.pool.ensureMinimum();
    this.notifyRunningMaybeDone();
  }

  private notifyRunningMaybeDone(): void {
    if (this.pool.busyCount === 0) this.flushRunningWaiters();
  }

  private flushRunningWaiters(): void {
    const waiters = this.runningWaiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  private dispatch(): void {
    while (this.queue.size > 0) {
      let worker = this.pool.findIdle();
      if (!worker) {
        if (!this.pool.canSpawn()) break;
        try {
          worker = this.pool.spawn();
        } catch (error) {
          // Worker creation failed (e.g. CSP). Reject this job with a friendly
          // error and move on; subsequent jobs will fail the same way until the
          // queue drains, but none are left orphaned.
          const job = this.queue.dequeue();
          job?.reject(error as Error);
          continue;
        }
      }
      const job = this.queue.dequeue();
      if (!job) break;
      this.pool.markBusy(worker, job.id);
      worker.execute(job);
    }
  }
}
