import { Worker as NodeWorker } from "node:worker_threads";
import { nodeWorkerPrelude, workerSource } from "./workerSource";
import type { WorkerBackend, WorkerLike } from "./WorkerBackend";
import type { WorkerToMain } from "../protocol/messages";
import type { TransferableValue } from "../types";

/** Built once: the browser worker source plus the `parentPort` shim. */
const nodeSource = nodeWorkerPrelude + workerSource;

/**
 * Node's transfer-list type, taken from the method itself rather than imported
 * by name — @types/node has moved that name around between majors.
 */
type NodeTransferList = NonNullable<Parameters<NodeWorker["postMessage"]>[1]>;

/**
 * Adapts a Node `worker_threads` worker to the Web-Worker-shaped
 * {@link WorkerLike} the pool expects.
 *
 * Node exposes an EventEmitter (`.on("message" | "error" | "exit")`) where the
 * web exposes assignable `onmessage`/`onerror` properties, so this translates
 * between the two. It also gets something the web API cannot offer: `exit`
 * fires when a worker dies without throwing — an `OOM` kill, a hard
 * `process.exit()` inside a task — which the browser silently turns into a
 * hung job. Here it surfaces as a crash, and the pool replaces the worker.
 */
class NodeWorkerAdapter implements WorkerLike {
  onmessage: ((event: { data: WorkerToMain }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;

  private settled = false;

  constructor(private readonly worker: NodeWorker) {
    worker.on("message", (data: WorkerToMain) => this.onmessage?.({ data }));
    worker.on("error", (error: Error) => this.crash(error.message));
    worker.on("exit", (code: number) => {
      // A clean exit after terminate() is expected; anything else means the
      // worker died under us and the in-flight job will never be answered.
      if (code === 0) return;
      this.crash(`Worker stopped with exit code ${code}`);
    });
    // A warm pool must not hold the process open; `ref()` takes it back for as
    // long as a job is actually in flight.
    worker.unref();
  }

  ref(): void {
    this.worker.ref();
  }

  unref(): void {
    this.worker.unref();
  }

  private crash(message: string): void {
    if (this.settled) return; // error then exit must not report twice
    this.settled = true;
    this.onerror?.({ message });
  }

  postMessage(message: unknown, transfer?: TransferableValue[]): void {
    // Same signature as the web API, and Node runs the same structured-clone
    // algorithm, so a transfer list passes straight through. The two type
    // worlds (DOM `Transferable` vs Node `TransferListItem`) describe the same
    // runtime values, hence the cast.
    if (transfer && transfer.length > 0) {
      this.worker.postMessage(message, transfer as unknown as NodeTransferList);
    } else {
      this.worker.postMessage(message);
    }
  }

  terminate(): void {
    this.settled = true; // the exit we are about to cause is not a crash
    this.worker.removeAllListeners();
    void this.worker.terminate();
  }
}

/**
 * Spawns workers on Node's `worker_threads`.
 *
 * There is no blob URL here and none is needed: Node can take the worker source
 * directly with `{ eval: true }`, which is simpler than the browser path. A
 * `workerUrl` is still honoured and is interpreted as a module path or
 * `file:` URL holding AhWork's worker source.
 */
export class NodeWorkerFactory implements WorkerBackend {
  constructor(private readonly workerUrl?: string) {}

  create(): WorkerLike {
    const worker =
      this.workerUrl !== undefined
        ? new NodeWorker(this.workerUrl)
        : new NodeWorker(nodeSource, { eval: true });
    return new NodeWorkerAdapter(worker);
  }

  dispose(): void {
    // Nothing shared to release: no blob URL, no object URL registry.
  }
}
