/** High-resolution timestamp in milliseconds, falling back to Date.now(). */
export function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
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
