import { describe, it, expect } from "vitest";
import { ManagedWorker } from "../src/workers/WorkerInstance";
import { RuntimeError } from "../src/errors/RuntimeError";
import type { Job } from "../src/scheduler/Job";

const noopCallbacks = { onSettled: () => {}, onCrashed: () => {} };

function trackedJob(id: string, taskId = "t1") {
  const state: { rejected?: Error; resolved?: unknown } = {};
  const job: Job = {
    id,
    taskId,
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

describe("ManagedWorker registration integrity (P1 #1, #3)", () => {
  it("does not mark a task registered if REGISTER_TASK postMessage fails, and retries later", () => {
    const sent: Array<{ type: string }> = [];
    class FlakyWorker {
      onmessage: unknown = null;
      onerror: unknown = null;
      onmessageerror: unknown = null;
      failRegister = true;
      postMessage(message: { type: string }): void {
        if (message.type === "REGISTER_TASK" && this.failRegister) {
          this.failRegister = false;
          throw new DOMException("could not clone context", "DataCloneError");
        }
        sent.push(message);
      }
      terminate(): void {}
    }
    const raw = new FlakyWorker();
    const worker = new ManagedWorker(
      "w1",
      raw as unknown as Worker,
      () => ({ source: "(x) => x", hasContext: true, context: {} }),
      noopCallbacks,
    );

    // First attempt: REGISTER throws -> job rejected, task NOT marked registered.
    const first = trackedJob("j1");
    worker.execute(first.job);
    expect(first.state.rejected?.name).toBe("DataCloneError");
    expect(worker.registeredTasks.has("t1")).toBe(false);
    expect(sent).toHaveLength(0);

    // Second attempt: REGISTER is retried (not skipped) and now succeeds.
    const second = trackedJob("j2");
    worker.execute(second.job);
    expect(worker.registeredTasks.has("t1")).toBe(true);
    expect(sent.map((m) => m.type)).toEqual(["REGISTER_TASK", "EXECUTE"]);
    expect(second.state.rejected).toBeUndefined();
  });

  it("surfaces a non-clone error (unknown task) as-is, not as DataCloneError", () => {
    class SilentWorker {
      onmessage: unknown = null;
      onerror: unknown = null;
      onmessageerror: unknown = null;
      postMessage(): void {}
      terminate(): void {}
    }
    const worker = new ManagedWorker(
      "w1",
      new SilentWorker() as unknown as Worker,
      () => {
        throw new RuntimeError("Unknown task for id: t1");
      },
      noopCallbacks,
    );

    const job = trackedJob("j1");
    worker.execute(job.job);
    expect(job.state.rejected).toBeInstanceOf(RuntimeError);
    expect(job.state.rejected?.name).toBe("RuntimeError");
    expect(job.state.rejected?.message).toMatch(/Unknown task/);
  });

  it("unregister() drops the task locally and notifies the worker", () => {
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
    const worker = new ManagedWorker(
      "w1",
      new RecordingWorker() as unknown as Worker,
      () => ({ source: "(x) => x", hasContext: false }),
      noopCallbacks,
    );

    worker.execute(trackedJob("j1").job); // registers t1
    expect(worker.registeredTasks.has("t1")).toBe(true);

    worker.unregister("t1");
    expect(worker.registeredTasks.has("t1")).toBe(false);
    expect(sent.at(-1)).toMatchObject({ type: "UNREGISTER_TASK", taskId: "t1" });

    // Unregistering an unknown task is a no-op (no extra message).
    const before = sent.length;
    worker.unregister("t1");
    expect(sent.length).toBe(before);
  });
});
