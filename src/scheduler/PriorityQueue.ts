import { JobQueue } from "./JobQueue";
import type { Job } from "./Job";

/** A job's effective level: absent priority means the default level `0`. */
function levelOf(job: Job): number {
  return job.priority ?? 0;
}

/**
 * Waiting queue ordered by priority, built from one FIFO bucket per level.
 *
 * Buckets rather than a binary heap, for two reasons. Dispatch stays O(1) in
 * the number of waiting jobs (only the number of *distinct levels* matters,
 * which is tiny in practice), and — more importantly — **order within a level
 * stays strictly FIFO**. A heap gives no such guarantee, which would make
 * `task.map()` dispatch its hundred identical jobs in an arbitrary order.
 *
 * With every job at the default level there is exactly one bucket, so this
 * degenerates to the plain FIFO it replaces. That is the intended baseline:
 * enabling priorities is opt-in per job, and code that never sets one cannot
 * observe a behaviour change.
 *
 * ## Starvation
 *
 * Strict priority means low-priority jobs may never run while high-priority
 * work keeps arriving. The guard is a quota: every `fairness`-th dispatch
 * ignores priority and takes the globally oldest waiting job. It is O(1) per
 * dispatch, needs no timers, and is trivially testable — deliberately chosen
 * over wait-time aging, where the behaviour is harder to explain and to prove.
 */
export class PriorityQueue {
  private readonly buckets = new Map<number, JobQueue>();
  /** Active levels, highest first. Kept sorted on insert; levels are few. */
  private levels: number[] = [];
  private count = 0;
  private nextSeq = 0;
  /** Dispatches since the last fairness pick. */
  private sinceFair = 0;

  /**
   * @param fairness Every `fairness`-th dispatch takes the oldest waiting job
   * regardless of priority. `<= 0` disables the guard (strict priority).
   */
  constructor(private readonly fairness: number) {}

  get size(): number {
    return this.count;
  }

  enqueue(job: Job): void {
    job.seq = this.nextSeq;
    this.nextSeq += 1;
    this.bucketFor(levelOf(job)).enqueue(job);
    this.count += 1;
  }

  dequeue(): Job | undefined {
    if (this.count === 0) return undefined;

    this.sinceFair += 1;
    const fairTurn = this.fairness > 0 && this.sinceFair >= this.fairness;
    if (fairTurn) this.sinceFair = 0;

    const level = fairTurn ? this.oldestLevel() : this.levels[0];
    return this.takeFrom(level);
  }

  /** Remove a specific job (cancellation of a still-queued job). */
  remove(jobId: string): Job | undefined {
    for (const level of this.levels) {
      const job = this.buckets.get(level)?.remove(jobId);
      if (job) {
        this.count -= 1;
        this.pruneIfEmpty(level);
        return job;
      }
    }
    return undefined;
  }

  /**
   * Drop the newest job of the lowest level, but only if `incoming` outranks
   * it. Returns the victim, or `undefined` when nothing may be evicted.
   *
   * The strict comparison matters: without it a flood of equal-priority jobs
   * would evict each other one by one and the queue would thrash instead of
   * applying backpressure. A job that does not outrank the queue's weakest
   * member has no claim on its slot, so the caller rejects the newcomer.
   */
  evictLowerThan(incoming: number): Job | undefined {
    const lowest = this.levels[this.levels.length - 1];
    if (lowest === undefined || incoming <= lowest) return undefined;
    const job = this.buckets.get(lowest)?.pop();
    if (!job) return undefined;
    this.count -= 1;
    this.pruneIfEmpty(lowest);
    return job;
  }

  /** Remove and return every queued job, highest level first (shutdown). */
  drain(): Job[] {
    const all: Job[] = [];
    for (const level of this.levels) {
      const bucket = this.buckets.get(level);
      if (bucket) all.push(...bucket.drain());
    }
    this.buckets.clear();
    this.levels = [];
    this.count = 0;
    return all;
  }

  private bucketFor(level: number): JobQueue {
    let bucket = this.buckets.get(level);
    if (bucket === undefined) {
      bucket = new JobQueue();
      this.buckets.set(level, bucket);
      // Descending insert; the number of distinct levels stays small, so a
      // linear insertion beats maintaining a heap of levels.
      const at = this.levels.findIndex((existing) => existing < level);
      this.levels.splice(at === -1 ? this.levels.length : at, 0, level);
    }
    return bucket;
  }

  /** The level whose head job was enqueued first, across all buckets. */
  private oldestLevel(): number {
    let best = this.levels[0];
    let bestSeq = Infinity;
    for (const level of this.levels) {
      const head = this.buckets.get(level)?.peek();
      if (head === undefined) continue;
      const seq = head.seq ?? 0;
      if (seq < bestSeq) {
        bestSeq = seq;
        best = level;
      }
    }
    return best;
  }

  private takeFrom(level: number | undefined): Job | undefined {
    if (level === undefined) return undefined;
    const job = this.buckets.get(level)?.dequeue();
    if (!job) return undefined;
    this.count -= 1;
    this.pruneIfEmpty(level);
    return job;
  }

  private pruneIfEmpty(level: number): void {
    if ((this.buckets.get(level)?.size ?? 0) > 0) return;
    this.buckets.delete(level);
    this.levels = this.levels.filter((existing) => existing !== level);
  }
}
