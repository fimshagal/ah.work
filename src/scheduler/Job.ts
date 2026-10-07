import type { TransferableValue } from "../types";

/** Internal representation of a single task invocation. */
export interface Job {
  id: string;
  taskId: string;
  args: unknown[];
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  createdAt: number;
  /** Set by the worker when execution actually begins (for stats). */
  startedAt?: number;
  signal?: AbortSignal;
  timeout?: number;
  transfer?: TransferableValue[];
  /** Higher runs sooner. Absent means `0`, which is the default level. */
  priority?: number;
  /**
   * Global enqueue order, assigned by the queue. `createdAt` cannot be used for
   * this: it is a `performance.now()` reading, so two jobs submitted in the
   * same tick can tie, and a retried job keeps the original timestamp.
   */
  seq?: number;
}
