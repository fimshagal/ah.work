/** High-resolution timestamp in milliseconds, falling back to Date.now(). */
export function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/**
 * Mark a background timer as not worth keeping the host alive for.
 *
 * Node's timers expose `unref`; the DOM's numeric handles do not, so this is a
 * no-op in the browser. Used for housekeeping timers (idle-worker reaping)
 * that should never be the reason a Node process refuses to exit.
 */
export function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}

/** Incremental running average, used for lightweight runtime statistics. */
export class RunningAverage {
  private count = 0;
  private mean = 0;

  add(value: number): void {
    this.count += 1;
    this.mean += (value - this.mean) / this.count;
  }

  get value(): number {
    return this.mean;
  }
}
