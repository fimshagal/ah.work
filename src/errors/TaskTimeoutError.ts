import { RuntimeError } from "./RuntimeError";

/** Thrown when a job exceeds its configured timeout. */
export class TaskTimeoutError extends RuntimeError {
  constructor(message = "Task exceeded its timeout", options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskTimeoutError";
  }
}
