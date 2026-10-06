import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WorkerPool } from "../src/workers/WorkerPool";
import { Scheduler } from "../src/scheduler/Scheduler";
import type { WorkerFactory } from "../src/workers/WorkerFactory";
import type { Job } from "../src/scheduler/Job";
import { AbortError } from "../src/errors/AbortError";
import { TaskTimeoutError } from "../src/errors/TaskTimeoutError";
import { WorkerSpawnError } from "../src/errors/WorkerSpawnError";
import { RuntimeShutdownError } from "../src/errors/RuntimeShutdownError";

// Minimal Worker stand-in so the pool/scheduler scaling logic can be tested
// deterministically in Node (jsdom has no Web Worker). It never runs code; it
// only satisfies the ManagedWorker's handler assignments and terminate().
class FakeWorker {
  onmessage: unknown = null;
  onerror: unknown = null;
  onmessageerror: unknown = null;
  postMessage(): void {}
  terminate(): void {}
}

function fakeFactory(): WorkerFactory {
  return {
    create: () => new FakeWorker() as unknown as Worker,
    dispose: () => {},
  } as unknown as WorkerFactory;
}

const noopCallbacks = { onSettled: () => {}, onCrashed: () => {} };
const registration = () => ({ source: "(x) => x", hasContext: false });

function makeJob(id: string): Job {
  return {
    id,
    taskId: "t1",
    args: [],
    createdAt: 0,
    resolve: () => {},
    reject: () => {},
  };
}

function trackedJob(id: string) {
  const state: { rejected?: Error; resolved?: unknown } = {};
  const job: Job = {
    id,
    taskId: "t1",
    args: [],
    createdAt: 0,
    resolve: (v) => {
      state.resolved = v;
    },
    reject: (e) => {
      state.rejected = e;
    },
  };
  return { job, state };
}

describe("WorkerPool auto-scaling (phase 4)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("prewarms up to minWorkers via ensureMinimum()", () => {
    const pool = new WorkerPool(
      fakeFactory(),
      { minWorkers: 2, maxWorkers: 4, idleTimeout: 1000 },
      registration,
      noopCallbacks,
    );
    pool.ensureMinimum();
    expect(pool.size).toBe(2);
  });

  it("terminates idle workers down to minWorkers after idleTimeout", () => {
    const pool = new WorkerPool(
      fakeFactory(),
      { minWorkers: 1, maxWorkers: 4, idleTimeout: 1000 },
      registration,
      noopCallbacks,
    );
    const a = pool.spawn();
    const b = pool.spawn();
    const c = pool.spawn();
    expect(pool.size).toBe(3);

    pool.markIdle(a);
    pool.markIdle(b);
    pool.markIdle(c);

    vi.advanceTimersByTime(1000);
    expect(pool.size).toBe(1); // never below minWorkers
  });

  it("does not terminate idle workers when idleTimeout <= 0", () => {
    const pool = new WorkerPool(
      fakeFactory(),
      { minWorkers: 0, maxWorkers: 4, idleTimeout: 0 },
      registration,
      noopCallbacks,
    );
    const a = pool.spawn();
    pool.markIdle(a);

    vi.advanceTimersByTime(100_000);
    expect(pool.size).toBe(1);
  });

  it("never terminates a busy worker", () => {
    const pool = new WorkerPool(
      fakeFactory(),
      { minWorkers: 0, maxWorkers: 4, idleTimeout: 1000 },
      registration,
      noopCallbacks,
    );
    const a = pool.spawn();
    a.execute(makeJob("j1")); // becomes busy, no idle timer armed

    vi.advanceTimersByTime(5000);
    expect(pool.size).toBe(1);
    expect(a.state).toBe("busy");
  });

  it("cancels the idle timer when a worker is reused (markBusy)", () => {
    const pool = new WorkerPool(
      fakeFactory(),
      { minWorkers: 0, maxWorkers: 4, idleTimeout: 1000 },
      registration,
      noopCallbacks,
    );
    const a = pool.spawn();
    pool.markIdle(a);
    pool.markBusy(a); // reused before timeout

    vi.advanceTimersByTime(5000);
    expect(pool.size).toBe(1);
  });
});

describe("Scheduler prewarming (phase 4)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("prewarms minWorkers on construction", () => {
    const scheduler = new Scheduler(
      fakeFactory(),
      { minWorkers: 2, maxWorkers: 4, idleTimeout: 1000 },
      registration,
    );
    expect(scheduler.workerCount).toBe(2);
  });
});

describe("context passing (phase 4)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends REGISTER_TASK with the serialized context, then EXECUTE", () => {
    const messages: unknown[] = [];
    class RecordingWorker {
      onmessage: unknown = null;
      onerror: unknown = null;
      onmessageerror: unknown = null;
      postMessage(message: unknown): void {
        messages.push(message);
      }
      terminate(): void {}
    }
    const factory = {
      create: () => new RecordingWorker() as unknown as Worker,
      dispose: () => {},
    } as unknown as WorkerFactory;

    const scheduler = new Scheduler(
      factory,
      { minWorkers: 0, maxWorkers: 1, idleTimeout: 0 },
      () => ({
        source: "(x, ctx) => x * ctx.multiplier",
        hasContext: true,
        context: { multiplier: 10 },
      }),
    );

    scheduler.submit(makeJob("j1"));

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      type: "REGISTER_TASK",
      taskId: "t1",
      hasContext: true,
      context: { multiplier: 10 },
    });
    expect(messages[1]).toMatchObject({
      type: "EXECUTE",
      jobId: "j1",
      taskId: "t1",
    });
  });
});

describe("crash replacement and graceful wait (phase 6)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("rejects the running job and refills minWorkers after onerror", () => {
    const created: FakeWorker[] = [];
    const factory = {
      create: () => {
        const w = new FakeWorker();
        created.push(w);
        return w as unknown as Worker;
      },
      dispose: () => {},
    } as unknown as WorkerFactory;

    const scheduler = new Scheduler(
      factory,
      { minWorkers: 1, maxWorkers: 2, idleTimeout: 0 },
      registration,
    );
    const running = trackedJob("j1");
    scheduler.submit(running.job);
    expect(scheduler.workerCount).toBe(1);

    const handler = created[0]?.onerror as ((event: { message: string }) => void) | null;
    handler?.({ message: "boom" });

    expect(running.state.rejected).toBeInstanceOf(Error);
    expect(running.state.rejected?.name).toBe("WorkerCrashedError");
    expect(scheduler.workerCount).toBe(1); // ensureMinimum
    expect(scheduler.busyWorkers).toBe(0);
  });

  it("assigns the next queued job to a replacement worker after a crash", () => {
    const created: FakeWorker[] = [];
    const factory = {
      create: () => {
        const w = new FakeWorker();
        created.push(w);
        return w as unknown as Worker;
      },
      dispose: () => {},
    } as unknown as WorkerFactory;

    const scheduler = new Scheduler(
      factory,
      { minWorkers: 0, maxWorkers: 1, idleTimeout: 0 },
      registration,
    );
    const first = trackedJob("j1");
    const second = trackedJob("j2");
    scheduler.submit(first.job);
    scheduler.submit(second.job);
    expect(scheduler.queuedJobs).toBe(1);

    const handler = created[0]?.onerror as ((event: { message: string }) => void) | null;
    handler?.({ message: "boom" });

    expect(first.state.rejected?.name).toBe("WorkerCrashedError");
    expect(scheduler.queuedJobs).toBe(0);
    expect(scheduler.busyWorkers).toBe(1);
    expect(second.state.rejected).toBeUndefined();
  });

  it("whenRunningDone resolves after the in-flight job is cancelled", async () => {
    const scheduler = new Scheduler(
      fakeFactory(),
      { minWorkers: 0, maxWorkers: 1, idleTimeout: 0 },
      registration,
    );
    const running = trackedJob("j1");
    scheduler.submit(running.job);

    let done = false;
    const wait = scheduler.whenRunningDone().then(() => {
      done = true;
    });
    expect(done).toBe(false);

    scheduler.cancelJob("j1", new AbortError());
    await wait;
    expect(done).toBe(true);
  });

  it("rejects a job when postMessage throws (structured clone)", () => {
    class ThrowingWorker {
      onmessage: unknown = null;
      onerror: unknown = null;
      onmessageerror: unknown = null;
      postMessage(): void {
        throw new DOMException("could not clone", "DataCloneError");
      }
      terminate(): void {}
    }
    const factory = {
      create: () => new ThrowingWorker() as unknown as Worker,
      dispose: () => {},
    } as unknown as WorkerFactory;

    const scheduler = new Scheduler(
      factory,
      { minWorkers: 0, maxWorkers: 1, idleTimeout: 0 },
      registration,
    );
    const job = trackedJob("j1");
    scheduler.submit(job.job);
    expect(job.state.rejected?.name).toBe("DataCloneError");
    expect(job.state.rejected?.message).toMatch(/structured-clone/i);
  });
});

describe("Scheduler cancellation (phase 5)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("cancels a queued job: removes it and rejects", () => {
    // Fake workers never settle, so the first job keeps the single worker busy.
    const scheduler = new Scheduler(
      fakeFactory(),
      { minWorkers: 0, maxWorkers: 1, idleTimeout: 0 },
      registration,
    );
    const running = trackedJob("j1");
    const queued = trackedJob("j2");
    scheduler.submit(running.job); // assigned -> worker busy
    scheduler.submit(queued.job); // stays queued (max 1)
    expect(scheduler.queuedJobs).toBe(1);

    const ok = scheduler.cancelJob("j2", new AbortError());
    expect(ok).toBe(true);
    expect(scheduler.queuedJobs).toBe(0);
    expect(queued.state.rejected).toBeInstanceOf(AbortError);
    expect(running.state.rejected).toBeUndefined();
  });

  it("cancels a running job: terminates the worker and rejects", () => {
    const scheduler = new Scheduler(
      fakeFactory(),
      { minWorkers: 0, maxWorkers: 2, idleTimeout: 0 },
      registration,
    );
    const running = trackedJob("j1");
    scheduler.submit(running.job);
    expect(scheduler.workerCount).toBe(1);

    const ok = scheduler.cancelJob("j1", new TaskTimeoutError());
    expect(ok).toBe(true);
    expect(running.state.rejected).toBeInstanceOf(TaskTimeoutError);
    expect(scheduler.workerCount).toBe(0); // terminated & removed (minWorkers 0)
  });

  it("refills to minWorkers after cancelling a running job", () => {
    const scheduler = new Scheduler(
      fakeFactory(),
      { minWorkers: 1, maxWorkers: 2, idleTimeout: 0 },
      registration,
    );
    const running = trackedJob("j1");
    scheduler.submit(running.job);
    scheduler.cancelJob("j1", new AbortError());
    expect(scheduler.workerCount).toBe(1); // replacement spawned for minWorkers
  });

  it("returns false when the job is unknown / already finished", () => {
    const scheduler = new Scheduler(
      fakeFactory(),
      { minWorkers: 0, maxWorkers: 1, idleTimeout: 0 },
      registration,
    );
    expect(scheduler.cancelJob("nope", new AbortError())).toBe(false);
  });
});

describe("Scheduler spawn failure / CSP (P1 #2)", () => {
  it("rejects a job with WorkerSpawnError and leaves no orphan in the queue", () => {
    const factory = {
      create: () => {
        throw new Error("blob: worker blocked by CSP");
      },
      dispose: () => {},
    } as unknown as WorkerFactory;

    const scheduler = new Scheduler(
      factory,
      { minWorkers: 0, maxWorkers: 2, idleTimeout: 0 },
      registration,
    );
    const job = trackedJob("j1");
    const accepted = scheduler.submit(job.job);

    expect(accepted).toBe(true); // it was enqueued, then dispatch failed
    expect(job.state.rejected).toBeInstanceOf(WorkerSpawnError);
    expect(scheduler.queuedJobs).toBe(0); // no orphaned job left behind
    expect(scheduler.workerCount).toBe(0);
  });

  it("rejects every queued job when spawning keeps failing", () => {
    const factory = {
      create: () => {
        throw new Error("CSP");
      },
      dispose: () => {},
    } as unknown as WorkerFactory;

    const scheduler = new Scheduler(
      factory,
      { minWorkers: 0, maxWorkers: 4, idleTimeout: 0 },
      registration,
    );
    const a = trackedJob("j1");
    const b = trackedJob("j2");
    scheduler.submit(a.job);
    scheduler.submit(b.job);

    expect(a.state.rejected?.name).toBe("WorkerSpawnError");
    expect(b.state.rejected?.name).toBe("WorkerSpawnError");
    expect(scheduler.queuedJobs).toBe(0);
  });
});

describe("Scheduler backpressure maxQueue (P2 #6)", () => {
  it("rejects submissions once the waiting queue is full", () => {
    // Fake workers never settle, so the single worker stays busy forever.
    const scheduler = new Scheduler(
      fakeFactory(),
      { minWorkers: 0, maxWorkers: 1, idleTimeout: 0, maxQueue: 1 },
      registration,
    );
    expect(scheduler.submit(trackedJob("j1").job)).toBe(true); // runs
    expect(scheduler.submit(trackedJob("j2").job)).toBe(true); // queued (size 1)
    expect(scheduler.submit(trackedJob("j3").job)).toBe(false); // over cap
    expect(scheduler.queuedJobs).toBe(1);
  });

  it("treats maxQueue <= 0 as unbounded", () => {
    const scheduler = new Scheduler(
      fakeFactory(),
      { minWorkers: 0, maxWorkers: 1, idleTimeout: 0, maxQueue: 0 },
      registration,
    );
    scheduler.submit(trackedJob("j1").job);
    for (let i = 2; i <= 50; i += 1) {
      expect(scheduler.submit(trackedJob(`j${i}`).job)).toBe(true);
    }
    expect(scheduler.queuedJobs).toBe(49);
  });
});

describe("Scheduler immediate rejection (Round 2 #1)", () => {
  it("terminates and removes the worker when its running job is rejected", () => {
    const terminations: string[] = [];
    class TrackingWorker {
      onmessage: unknown = null;
      onerror: unknown = null;
      onmessageerror: unknown = null;
      postMessage(): void {}
      terminate(): void {
        terminations.push("terminated");
      }
    }
    const factory = {
      create: () => new TrackingWorker() as unknown as Worker,
      dispose: () => {},
    } as unknown as WorkerFactory;

    const scheduler = new Scheduler(
      factory,
      { minWorkers: 0, maxWorkers: 1, idleTimeout: 0 },
      registration,
    );
    const job = trackedJob("j1");
    scheduler.submit(job.job);
    expect(scheduler.workerCount).toBe(1);

    scheduler.rejectRunning(new RuntimeShutdownError());

    expect(job.state.rejected).toBeInstanceOf(RuntimeShutdownError);
    expect(scheduler.workerCount).toBe(0); // worker removed, not just idled
    expect(scheduler.busyWorkers).toBe(0);
    expect(terminations).toHaveLength(1); // terminated immediately
  });
});

describe("Scheduler task unregistration (P2 #5)", () => {
  it("broadcasts UNREGISTER_TASK to workers holding the task", () => {
    const sent: Array<{ type: string; taskId?: string }> = [];
    class RecordingWorker {
      onmessage: unknown = null;
      onerror: unknown = null;
      onmessageerror: unknown = null;
      postMessage(message: { type: string; taskId?: string }): void {
        sent.push(message);
      }
      terminate(): void {}
    }
    const factory = {
      create: () => new RecordingWorker() as unknown as Worker,
      dispose: () => {},
    } as unknown as WorkerFactory;

    const scheduler = new Scheduler(
      factory,
      { minWorkers: 0, maxWorkers: 1, idleTimeout: 0 },
      registration,
    );
    scheduler.submit(makeJob("j1")); // registers t1 on the worker
    expect(sent.map((m) => m.type)).toEqual(["REGISTER_TASK", "EXECUTE"]);

    scheduler.unregisterTask("t1");
    expect(sent.at(-1)).toMatchObject({ type: "UNREGISTER_TASK", taskId: "t1" });
  });
});
