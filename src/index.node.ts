import { availableParallelism } from "node:os";
import { AhWorkRuntime } from "./runtime/Runtime";
import { NodeWorkerFactory } from "./workers/NodeWorkerFactory";
import type { Runtime, RuntimeOptions } from "./types";

export * from "./api";

/**
 * The shim that makes `workerSourceCode` run under `worker_threads`. Only
 * needed if you host the worker yourself and pass `workerUrl`; the default
 * path prepends it for you.
 */
export { nodeWorkerPrelude } from "./workers/workerSource";

/**
 * Resolve `"auto"` the way a server should: `availableParallelism()` honours
 * cgroup CPU limits, so a container capped at 2 cores reports 2 rather than
 * the host's 64. The shared default (`navigator.hardwareConcurrency`) only
 * exists from Node 21 and ignores those limits.
 */
function withNodeDefaults(options?: RuntimeOptions): RuntimeOptions {
  if (options?.maxWorkers !== undefined && options.maxWorkers !== "auto") {
    return options;
  }
  return { ...options, maxWorkers: availableParallelism() };
}

/**
 * Create an AhWork runtime backed by Node's **`worker_threads`**.
 *
 * Identical API to the Web Worker build — same tasks, same `context` and
 * `inject`, same structured-clone rules, same transfer lists. Node is selected
 * automatically by conditional exports, so application code just writes
 * `import { createRuntime } from "ahwork"`.
 *
 * Workers are spawned from the bundled source with `{ eval: true }`, so there
 * is no file to host and no blob URL. An idle pool is `unref`'d and will not
 * keep the process alive; a worker is `ref`'d again for exactly as long as it
 * has a job in flight, so awaiting a result never races process exit.
 */
export function createRuntime(options?: RuntimeOptions): Runtime {
  const resolved = withNodeDefaults(options);
  return new AhWorkRuntime(resolved, new NodeWorkerFactory(resolved.workerUrl));
}
