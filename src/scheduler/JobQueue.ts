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
