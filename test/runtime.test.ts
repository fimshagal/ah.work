import { describe, it, expect } from "vitest";
import {
  createRuntime,
  RuntimeError,
  RuntimeShutdownError,
  AbortError,
} from "../src";
import { resolveOptions } from "../src/runtime/Runtime";

// NOTE: jsdom has no Web Worker, so these tests cover only the parts that do not
// execute jobs (API surface, lazy worker creation, stats before any work).
// Real execution tests (single task, concurrency, reuse, errors, shutdown) run
// under Vitest browser mode with real Workers — added in the testing phase.

describe("AhWork runtime (phases 1-3, non-executing checks)", () => {
  it("exposes the expected runtime API surface", () => {
    const runtime = createRuntime({ maxWorkers: 2 });
    expect(runtime.task).toBeTypeOf("function");
    expect(runtime.stats).toBeTypeOf("function");
    expect(runtime.shutdown).toBeTypeOf("function");
  });

  it("task() returns a callable with run() and map()", () => {
    const runtime = createRuntime();
    const task = runtime.task((n: number) => n * 2);
    expect(task).toBeTypeOf("function");
    expect(task.run).toBeTypeOf("function");
    expect(task.map).toBeTypeOf("function");
  });

  it("does not spawn workers until work is submitted", () => {
    const runtime = createRuntime({ maxWorkers: 4 });
    runtime.task((n: number) => n + 1); // registering a task must not spawn
    const stats = runtime.stats();
    expect(stats.workers).toBe(0);
    expect(stats.queuedJobs).toBe(0);
    expect(stats.completedJobs).toBe(0);
    expect(stats.failedJobs).toBe(0);
  });

  it("rejects task invocation after shutdown", async () => {
    const runtime = createRuntime();
    const task = runtime.task((n: number) => n);
    await runtime.shutdown();
    await expect(task(1)).rejects.toBeInstanceOf(RuntimeShutdownError);
  });

  it("graceful shutdown with no running jobs matches immediate cleanup", async () => {
    const runtime = createRuntime({ minWorkers: 0 });
    await runtime.shutdown({ graceful: true });
    const task = runtime.task((n: number) => n);
    await expect(task(1)).rejects.toBeInstanceOf(RuntimeShutdownError);
    expect(runtime.stats().workers).toBe(0);
  });

  it("repeated shutdown is a no-op", async () => {
    const runtime = createRuntime();
    await runtime.shutdown();
    await runtime.shutdown({ graceful: true });
  });

  it("rejects immediately with AbortError for an already-aborted signal", async () => {
    const runtime = createRuntime();
    const task = runtime.task((n: number) => n);
    const controller = new AbortController();
    controller.abort();
    // Short-circuits before any worker is spawned.
    await expect(
      task.run([1], { signal: controller.signal }),
    ).rejects.toBeInstanceOf(AbortError);
    expect(runtime.stats().workers).toBe(0);
    await runtime.shutdown();
  });

  it("exposes custom error classes", () => {
    const err = new RuntimeError("boom");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("RuntimeError");
  });

  it("rejects a task that has been disposed", async () => {
    const runtime = createRuntime();
    const task = runtime.task((n: number) => n);
    task.dispose();
    await expect(task(1)).rejects.toBeInstanceOf(RuntimeError);
    await runtime.shutdown();
  });

  it("does not record timing for jobs that never started", async () => {
    const runtime = createRuntime();
    const task = runtime.task((n: number) => n);
    const controller = new AbortController();
    controller.abort();
    await expect(
      task.run([1], { signal: controller.signal }),
    ).rejects.toBeInstanceOf(AbortError);

    const stats = runtime.stats();
    expect(stats.failedJobs).toBe(1);
    expect(stats.averageExecutionTime).toBe(0);
    expect(stats.averageWaitTime).toBe(0);
    await runtime.shutdown();
  });
});

describe("option validation (P1 #4)", () => {
  it("clamps minWorkers into [0, maxWorkers]", () => {
    expect(resolveOptions({ minWorkers: 10, maxWorkers: 2 })).toMatchObject({
      minWorkers: 2,
      maxWorkers: 2,
    });
    expect(resolveOptions({ minWorkers: -5, maxWorkers: 3 })).toMatchObject({
      minWorkers: 0,
      maxWorkers: 3,
    });
  });

  it("forces at least one worker", () => {
    expect(resolveOptions({ maxWorkers: 0 }).maxWorkers).toBe(1);
    expect(resolveOptions({ maxWorkers: -4 }).maxWorkers).toBe(1);
  });

  it("floors fractional worker counts and rejects NaN", () => {
    expect(resolveOptions({ maxWorkers: 3.9 }).maxWorkers).toBe(3);
    expect(resolveOptions({ maxWorkers: NaN }).maxWorkers).toBeGreaterThanOrEqual(1);
  });

  it("coerces negative / NaN timeouts and queue bounds to safe defaults", () => {
    expect(resolveOptions({ idleTimeout: -1 }).idleTimeout).toBe(0);
    expect(resolveOptions({ taskTimeout: NaN }).taskTimeout).toBe(0);
    expect(resolveOptions({ maxQueue: -10 }).maxQueue).toBe(0);
    expect(resolveOptions({ idleTimeout: undefined }).idleTimeout).toBe(10_000);
  });
});
