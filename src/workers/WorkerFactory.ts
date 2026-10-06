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
 * Creates Web Worker instances from the shared, reference-counted Blob URL.
 *
 * Each factory acquires the shared URL lazily on first use and releases it on
 * {@link dispose}. This is the one component tightly bound to Blob workers; a
 * future CSP/module backend would provide an alternative factory with the same
 * shape.
 */
export class WorkerFactory {
  private url: string | null = null;

  private getUrl(): string {
    if (this.url === null) {
      this.url = acquireSharedUrl();
    }
    return this.url;
  }

  /** Spawn a new worker from the shared blob URL. */
  create(): Worker {
    return new Worker(this.getUrl());
  }

  /** Release this factory's hold on the shared blob URL. */
  dispose(): void {
    if (this.url !== null) {
      this.url = null;
      releaseSharedUrl();
    }
  }
}
