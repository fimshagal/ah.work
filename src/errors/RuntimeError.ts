/** Base class for all AhWork errors. */
export class RuntimeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeError";
  }
}
