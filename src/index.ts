import { AhWorkRuntime } from "./runtime/Runtime";
import type { Runtime, RuntimeOptions } from "./types";

export * from "./api";

/**
 * Create an AhWork runtime: a task-oriented pool of **Web Workers**.
 *
 * This is the entry for browsers and for any runtime that implements the Web
 * Worker API (Deno, Bun). On Node, `import "ahwork"` resolves to the
 * `worker_threads` build automatically via conditional exports — same API.
 *
 * Importing this module does not spawn any workers; workers are created on
 * demand when work is submitted (or eagerly when `minWorkers` requests warmup).
 */
export function createRuntime(options?: RuntimeOptions): Runtime {
  return new AhWorkRuntime(options);
}
