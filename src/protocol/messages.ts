/**
 * Typed worker message protocol.
 *
 * This module is intentionally isolated from runtime logic: only serialization
 * and message shapes live here so that an alternative backend could reuse them.
 */

/** Error shape carried across the worker boundary. */
export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

// ---------------------------------------------------------------------------
// Main -> Worker
// ---------------------------------------------------------------------------

export interface RegisterTaskMessage {
  type: "REGISTER_TASK";
  taskId: string;
  source: string;
  /** Whether a serialized context object should be injected as the last arg. */
  hasContext: boolean;
  /** Serialized context data (structured-clone), sent once per worker+task. */
  context?: unknown;
  /**
   * Named helper functions (as source text) to define in the worker scope
   * before the task runs, so the task can call them by name.
   */
  inject?: Record<string, string>;
}

export interface ExecuteMessage {
  type: "EXECUTE";
  jobId: string;
  taskId: string;
  args: unknown[];
}

/** Drop a task's registration (and cached context) from the worker. */
export interface UnregisterTaskMessage {
  type: "UNREGISTER_TASK";
  taskId: string;
}

export type MainToWorker =
  | RegisterTaskMessage
  | ExecuteMessage
  | UnregisterTaskMessage;

// ---------------------------------------------------------------------------
// Worker -> Main
// ---------------------------------------------------------------------------

export interface TaskRegisteredMessage {
  type: "TASK_REGISTERED";
  taskId: string;
}

export interface TaskResultMessage {
  type: "TASK_RESULT";
  jobId: string;
  result: unknown;
}

export interface TaskErrorMessage {
  type: "TASK_ERROR";
  jobId: string;
  error: SerializedError;
}

export type WorkerToMain =
  | TaskRegisteredMessage
  | TaskResultMessage
  | TaskErrorMessage;

/** Exhaustiveness helper for discriminated-union switches. */
export function assertNever(value: never): never {
  throw new Error(`Unexpected message variant: ${JSON.stringify(value)}`);
}
