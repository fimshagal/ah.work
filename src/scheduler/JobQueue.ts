import type { Job } from "./Job";

/**
 * FIFO job queue with amortized O(1) enqueue/dequeue.
 *
 * Instead of `Array.shift()` (O(n)), a moving `head` index marks the front and
 * the backing array is compacted only occasionally. Kept deliberately small so
 * it can later be swapped for a priority queue without touching the scheduler.
 */
export class JobQueue {
  private items: Array<Job | undefined> = [];
  private head = 0;

  get size(): number {
    return this.items.length - this.head;
  }

  enqueue(job: Job): void {
    this.items.push(job);
  }

  /** The job that would come out next, without removing it. */
  peek(): Job | undefined {
    return this.head < this.items.length ? this.items[this.head] : undefined;
  }

  /**
   * Remove the **most recently** enqueued job.
   *
   * Used when a full queue has to make room for a higher-priority job: the
   * newest job is the one that has invested the least waiting time, and
   * dropping it (rather than the oldest) is what keeps the priority queue's
   * fairness quota meaningful — otherwise the job the quota is trying to
   * rescue would be the first one thrown away.
   */
  pop(): Job | undefined {
    if (this.head >= this.items.length) return undefined;
    return this.items.pop() as Job;
  }

  dequeue(): Job | undefined {
    if (this.head >= this.items.length) return undefined;
    const job = this.items[this.head];
    this.items[this.head] = undefined; // release the reference eagerly
    this.head += 1;
    // Compact once the dead prefix dominates, to bound memory growth.
    if (this.head > 1024 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return job;
  }

  /** Remove a specific job (used for cancellation of still-queued jobs). */
  remove(jobId: string): Job | undefined {
    for (let i = this.head; i < this.items.length; i += 1) {
      if (this.items[i]?.id === jobId) {
        const [job] = this.items.splice(i, 1);
        return job;
      }
    }
    return undefined;
  }

  /** Remove and return all queued jobs (used during shutdown). */
  drain(): Job[] {
    const rest = this.items.slice(this.head) as Job[];
    this.items = [];
    this.head = 0;
    return rest;
  }
}
