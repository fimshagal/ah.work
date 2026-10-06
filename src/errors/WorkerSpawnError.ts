import { RuntimeError } from "./RuntimeError";

/**
 * Thrown when a worker could not be created.
 *
 * The most common cause is a strict Content-Security-Policy that blocks
 * `blob:`/`worker-src`, so the message points at the `workerUrl` escape hatch.
 * The original construction error is preserved in `cause` when available.
 */
export class WorkerSpawnError extends RuntimeError {
  constructor(
    message = "Failed to create a Web Worker. A strict Content-Security-Policy may be blocking blob: workers (worker-src/script-src). Consider hosting a static worker entry via the workerUrl option.",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkerSpawnError";
  }
}
