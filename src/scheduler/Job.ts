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
}
