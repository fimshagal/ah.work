import { RuntimeError } from "./RuntimeError";

/** Thrown when a worker unexpectedly dies or becomes unusable. */
export class WorkerCrashedError extends RuntimeError {
  constructor(message = "Worker crashed", options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkerCrashedError";
  }
}
