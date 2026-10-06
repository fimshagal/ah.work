import { RuntimeError } from "./RuntimeError";

/** Thrown when a task is invoked after the runtime has been shut down. */
export class RuntimeShutdownError extends RuntimeError {
  constructor(message = "Runtime has been shut down", options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeShutdownError";
  }
}
