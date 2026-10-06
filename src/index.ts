import { AhWorkRuntime } from "./runtime/Runtime";
import type { Runtime, RuntimeOptions } from "./types";

/**
 * Create an AhWork runtime: a task-oriented pool of Web Workers.
 *
 * Importing this module does not spawn any workers; workers are created on
 * demand when work is submitted (or eagerly when `minWorkers` requests warmup).
 */
export function createRuntime(options?: RuntimeOptions): Runtime {
  return new AhWorkRuntime(options);
}

export type {
  Runtime,
  RuntimeOptions,
  RuntimeTask,
  RunOptions,
  MapInput,
  RuntimeStats,
  ShutdownOptions,
  TaskOptions,
} from "./types";

export { RuntimeError } from "./errors/RuntimeError";
export { TaskTimeoutError } from "./errors/TaskTimeoutError";
export { WorkerCrashedError } from "./errors/WorkerCrashedError";
export { WorkerSpawnError } from "./errors/WorkerSpawnError";
export { RuntimeShutdownError } from "./errors/RuntimeShutdownError";
export { AbortError } from "./errors/AbortError";
export { QueueFullError } from "./errors/QueueFullError";
