import { RuntimeError } from "./RuntimeError";

/**
 * Thrown when a job is cancelled via an AbortSignal.
 *
 * The original abort reason (often a native `DOMException`) is preserved in
 * `cause` when available.
 */
export class AbortError extends RuntimeError {
  constructor(message = "The operation was aborted", options?: ErrorOptions) {
    super(message, options);
    this.name = "AbortError";
  }
}
