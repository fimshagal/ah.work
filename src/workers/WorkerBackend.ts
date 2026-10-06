import type { WorkerToMain } from "../protocol/messages";
import type { TransferableValue } from "../types";

/**
 * The slice of the Web Worker API that AhWork actually uses.
 *
 * Everything above this interface — the pool, the scheduler, auto-scaling,
 * retries, stats, shutdown — is platform-agnostic. A backend only has to
 * produce objects shaped like this, which is why Node's `worker_threads` (an
 * EventEmitter API) can be supported by a thin adapter rather than a fork.
 */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: TransferableValue[]): void;
  terminate(): void;
  onmessage: ((event: { data: WorkerToMain }) => void) | null;
  onerror: ((event: { message: string }) => void) | null;
  onmessageerror: (() => void) | null;
  /**
   * Host-lifetime hints, implemented only where the host has a lifetime to
   * manage. On Node an idle pool must not keep the process alive, but a worker
   * with a job in flight must; browsers have no equivalent notion.
   */
  ref?(): void;
  unref?(): void;
}

/** Spawns workers for one runtime and owns whatever resources that needs. */
export interface WorkerBackend {
  /** Spawn a new worker. May throw; the pool turns that into WorkerSpawnError. */
  create(): WorkerLike;
  /** Release backend-held resources (e.g. a shared blob URL). */
  dispose(): void;
}
