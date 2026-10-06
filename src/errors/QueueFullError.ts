import { RuntimeError } from "./RuntimeError";

/**
 * Thrown when a job is submitted while the waiting queue is already at its
 * configured `maxQueue` capacity (backpressure).
 */
export class QueueFullError extends RuntimeError {
  constructor(
    message = "Job queue is full (maxQueue reached). The runtime is saturated; retry later or raise maxQueue.",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "QueueFullError";
  }
}
