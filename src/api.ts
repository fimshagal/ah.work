/**
 * Everything the two entry points share.
 *
 * `index.ts` (Web Workers) and `index.node.ts` (Node `worker_threads`) differ
 * in exactly one thing — which backend their `createRuntime` wires up. Keeping
 * the rest here is what stops the two public surfaces from drifting apart.
 */

export type {
  Runtime,
  RuntimeOptions,
  RuntimeTask,
  RunOptions,
  MapInput,
  RuntimeStats,
  ShutdownOptions,
  TaskOptions,
  InjectOptions,
  InjectMap,
  TransferableValue,
} from "./types";

/**
 * The raw worker runtime source. Host this string as a `.js` file and pass its
 * URL via `createRuntime({ workerUrl })` — in browsers whose CSP blocks `blob:`
 * workers, or in Node when you would rather ship a worker file than eval a
 * string. On Node, prepend `nodeWorkerPrelude` (exported from the Node entry).
 */
export { workerSource as workerSourceCode } from "./workers/workerSource";

export { RuntimeError } from "./errors/RuntimeError";
export { TaskTimeoutError } from "./errors/TaskTimeoutError";
export { WorkerCrashedError } from "./errors/WorkerCrashedError";
export { WorkerSpawnError } from "./errors/WorkerSpawnError";
export { RuntimeShutdownError } from "./errors/RuntimeShutdownError";
export { AbortError } from "./errors/AbortError";
export { QueueFullError } from "./errors/QueueFullError";
