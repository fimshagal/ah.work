import { workerSource } from "./workerSource";

/**
 * Module-level shared blob URL with reference counting.
 *
 * The worker source is identical for every runtime, so all factories share a
 * single `blob:` URL. It is created on first use and revoked only once the last
 * factory that acquired it has been disposed.
 */
let sharedUrl: string | null = null;
let refCount = 0;

function acquireSharedUrl(): string {
  if (sharedUrl === null) {
    const blob = new Blob([workerSource], { type: "text/javascript" });
    sharedUrl = URL.createObjectURL(blob);
  }
  refCount += 1;
  return sharedUrl;
}

function releaseSharedUrl(): void {
  refCount -= 1;
  if (refCount <= 0) {
    if (sharedUrl !== null) URL.revokeObjectURL(sharedUrl);
    sharedUrl = null;
    refCount = 0;
  }
}

/**
 * Creates Web Worker instances.
 *
 * Two backends:
 *  - default: a shared, reference-counted `blob:` URL built from the bundled
 *    worker source (zero setup, but blocked by strict CSP).
 *  - `workerUrl`: a statically hosted worker entry, for CSP-restricted sites.
 *    The hosted file must contain AhWork's worker source (see `workerSourceCode`
 *    export). No blob is created or revoked in this mode.
 */
export class WorkerFactory {
  private url: string | null = null;
  private readonly usesBlob: boolean;

  constructor(private readonly workerUrl?: string) {
    this.usesBlob = workerUrl === undefined;
  }

  private getUrl(): string {
    if (this.workerUrl !== undefined) return this.workerUrl;
    if (this.url === null) {
      this.url = acquireSharedUrl();
    }
    return this.url;
  }

  /** Spawn a new worker from the configured backend. */
  create(): Worker {
    return new Worker(this.getUrl());
  }

  /** Release this factory's hold on the shared blob URL (no-op for workerUrl). */
  dispose(): void {
    if (this.usesBlob && this.url !== null) {
      this.url = null;
      releaseSharedUrl();
    }
  }
}
