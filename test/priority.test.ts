import { describe, it, expect } from "vitest";
import { Scheduler, type SchedulerOptions } from "../src/scheduler/Scheduler";
import { PriorityQueue } from "../src/scheduler/PriorityQueue";
import type { WorkerBackend, WorkerLike } from "../src/workers/WorkerBackend";
import type { Job } from "../src/scheduler/Job";
import { QueueFullError } from "../src/errors/QueueFullError";

/**
 * A fake worker that records what it was asked to run and lets the test decide
 * when a job finishes. That is what makes *dispatch order* observable: with a
 * single worker, the sequence of EXECUTE messages is the scheduling decision.
 */
class RecordingWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: unknown = null;
  onmessageerror: unknown = null;
  readonly sent: Array<{ type: string; jobId?: string }> = [];

  postMessage(message: { type: string; jobId?: string }): void {
    this.sent.push(message);
  }

  terminate(): void {}

  get executed(): string[] {
    return this.sent
      .filter((m) => m.type === "EXECUTE")
      .map((m) => m.jobId as string);
  }

  /** Deliver a successful result for the job currently in flight. */
  settle(jobId: string): void {
    this.onmessage?.({ data: { type: "TASK_RESULT", jobId, result: null } });
  }
}

const registration = () => ({ source: "(x) => x", hasContext: false });

function harness(options: Partial<SchedulerOptions> = {}) {
  const workers: RecordingWorker[] = [];
  const factory: WorkerBackend = {
    create: () => {
      const worker = new RecordingWorker();
      workers.push(worker);
      return worker as unknown as WorkerLike;
    },
    dispose: () => {},
  };
  const scheduler = new Scheduler(
    factory,
    { minWorkers: 0, maxWorkers: 1, idleTimeout: 0, ...options },
    registration,
  );
  return { scheduler, workers };
}

function trackedJob(id: string, priority?: number) {
  const state: { rejected?: Error } = {};
  const job: Job = {
    id,
    taskId: "t1",
    args: [],
    createdAt: 0,
    priority,
    resolve: () => {},
    reject: (e) => {
      state.rejected = e;
    },
  };
  return { job, state };
}

function job(id: string, priority?: number): Job {
  return trackedJob(id, priority).job;
}

/** Settle jobs one by one until the queue is empty, returning dispatch order. */
function runToCompletion(worker: RecordingWorker): string[] {
  for (let guard = 0; guard < 100; guard += 1) {
    const inFlight = worker.executed[worker.executed.length - 1];
    if (inFlight === undefined) break;
    const before = worker.executed.length;
    worker.settle(inFlight);
    if (worker.executed.length === before) break; // nothing left to dispatch
  }
  return worker.executed;
}

describe("PriorityQueue (round 8)", () => {
  it("keeps strict FIFO when every job uses the default level", () => {
    const q = new PriorityQueue(0);
    for (const id of ["a", "b", "c"]) q.enqueue(job(id));
    expect([q.dequeue()?.id, q.dequeue()?.id, q.dequeue()?.id]).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(q.size).toBe(0);
  });

  it("orders by priority and stays FIFO within a level", () => {
    const q = new PriorityQueue(0);
    q.enqueue(job("lowA", 0));
    q.enqueue(job("high", 10));
    q.enqueue(job("lowB", 0));
    q.enqueue(job("mid", 5));
    const out = [q.dequeue(), q.dequeue(), q.dequeue(), q.dequeue()];
    expect(out.map((j) => j?.id)).toEqual(["high", "mid", "lowA", "lowB"]);
  });

  it("treats a missing priority as the default level 0", () => {
    const q = new PriorityQueue(0);
    q.enqueue(job("explicit", 0));
    q.enqueue(job("implicit"));
    expect([q.dequeue()?.id, q.dequeue()?.id]).toEqual([
      "explicit",
      "implicit",
    ]);
  });

  it("removes a queued job from any level (abort path)", () => {
    const q = new PriorityQueue(0);
    q.enqueue(job("high", 10));
    q.enqueue(job("low", 0));
    expect(q.remove("low")?.id).toBe("low");
    expect(q.remove("nope")).toBeUndefined();
    expect(q.size).toBe(1);
    expect(q.dequeue()?.id).toBe("high");
  });

  it("drains every level (shutdown path)", () => {
    const q = new PriorityQueue(0);
    q.enqueue(job("low", 0));
    q.enqueue(job("high", 10));
    expect(q.drain().map((j) => j.id).sort()).toEqual(["high", "low"]);
    expect(q.size).toBe(0);
    expect(q.dequeue()).toBeUndefined();
  });

  it("evicts the newest job of the lowest level, and only for a better rank", () => {
    const q = new PriorityQueue(0);
    q.enqueue(job("lowOld", 0));
    q.enqueue(job("lowNew", 0));
    q.enqueue(job("high", 10));

    expect(q.evictLowerThan(0)).toBeUndefined(); // equal rank: no claim
    expect(q.evictLowerThan(-1)).toBeUndefined(); // worse rank: no claim
    // The newest of the weakest level goes, so the job the fairness quota is
    // meant to rescue is not the first one thrown away.
    expect(q.evictLowerThan(5)?.id).toBe("lowNew");
    expect(q.size).toBe(2);
  });

  it("reports nothing to evict once the queue is empty", () => {
    const q = new PriorityQueue(0);
    expect(q.evictLowerThan(100)).toBeUndefined();
  });
});

describe("PriorityQueue starvation guard (round 8)", () => {
  it("lets a low-priority job through every Nth dispatch", () => {
    const q = new PriorityQueue(3);
    q.enqueue(job("low", 0));
    for (let i = 0; i < 5; i += 1) q.enqueue(job(`high${i}`, 10));

    const order: string[] = [];
    while (q.size > 0) order.push(q.dequeue()!.id);

    // Dispatches 3 and 6 ignore priority and take the oldest waiting job.
    expect(order).toEqual([
      "high0",
      "high1",
      "low",
      "high2",
      "high3",
      "high4",
    ]);
  });

  it("starves the low-priority job when the guard is disabled", () => {
    const q = new PriorityQueue(0);
    q.enqueue(job("low", 0));
    for (let i = 0; i < 5; i += 1) q.enqueue(job(`high${i}`, 10));

    const order: string[] = [];
    while (q.size > 0) order.push(q.dequeue()!.id);

    expect(order[order.length - 1]).toBe("low");
  });

  it("is invisible when every job shares one level", () => {
    const q = new PriorityQueue(2);
    for (const id of ["a", "b", "c", "d"]) q.enqueue(job(id));
    const order: string[] = [];
    while (q.size > 0) order.push(q.dequeue()!.id);
    expect(order).toEqual(["a", "b", "c", "d"]);
  });
});

describe("Scheduler priority dispatch (round 8)", () => {
  it("runs queued jobs in priority order on a saturated pool", () => {
    const { scheduler, workers } = harness();
    scheduler.submit(job("running", 0)); // takes the only worker
    scheduler.submit(job("lowA", 0));
    scheduler.submit(job("high", 10));
    scheduler.submit(job("lowB", 0));
    scheduler.submit(job("mid", 5));

    expect(runToCompletion(workers[0])).toEqual([
      "running",
      "high",
      "mid",
      "lowA",
      "lowB",
    ]);
  });

  it("is a no-op when nothing has to wait", () => {
    // Four workers for four jobs: the queue never holds anything, so the
    // low-priority job is not delayed at all.
    const { scheduler, workers } = harness({ maxWorkers: 4 });
    scheduler.submit(job("low", 0));
    scheduler.submit(job("high", 10));
    expect(workers).toHaveLength(2);
    expect(workers[0].executed).toEqual(["low"]);
    expect(workers[1].executed).toEqual(["high"]);
  });
});

describe("Scheduler onQueueFull policy (round 8)", () => {
  it("rejects the newcomer by default, leaving the queue untouched", () => {
    const { scheduler } = harness({ maxQueue: 1 });
    expect(scheduler.submit(job("running", 0))).toBe(true);
    expect(scheduler.submit(job("queued", 0))).toBe(true);
    expect(scheduler.submit(job("high", 10))).toBe(false);
    expect(scheduler.queuedJobs).toBe(1);
  });

  it("evicts the weakest queued job for a higher-priority newcomer", () => {
    const { scheduler } = harness({
      maxQueue: 2,
      onQueueFull: "evict-lowest",
    });
    scheduler.submit(job("running", 0));
    const low = trackedJob("low", 0);
    scheduler.submit(low.job);
    scheduler.submit(job("mid", 5));

    expect(scheduler.submit(job("high", 10))).toBe(true);
    expect(low.state.rejected).toBeInstanceOf(QueueFullError);
    expect(low.state.rejected?.message).toMatch(/evicted/i);
    expect(scheduler.queuedJobs).toBe(2);
  });

  it("refuses a newcomer that does not outrank the weakest queued job", () => {
    const { scheduler } = harness({
      maxQueue: 1,
      onQueueFull: "evict-lowest",
    });
    scheduler.submit(job("running", 0));
    const queued = trackedJob("queued", 5);
    scheduler.submit(queued.job);

    // Equal rank must not evict: otherwise a flood of same-priority jobs would
    // thrash the queue instead of applying backpressure.
    expect(scheduler.submit(job("same", 5))).toBe(false);
    expect(queued.state.rejected).toBeUndefined();
    expect(scheduler.queuedJobs).toBe(1);
  });
});
