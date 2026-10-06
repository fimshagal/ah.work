/**
 * Best-effort detection of Transferable objects inside task arguments.
 *
 * Used only when `autoTransfer` is enabled. Detection is deliberately
 * conservative: it recurses into arrays and plain objects (so it never detaches
 * buffers hidden inside class instances like Map/Set/Date unexpectedly) and
 * guards every environment-specific constructor behind a `typeof` check.
 */

import type { TransferableValue } from "../types";

function isTransferableObject(value: object): boolean {
  if (typeof MessagePort !== "undefined" && value instanceof MessagePort)
    return true;
  if (typeof ImageBitmap !== "undefined" && value instanceof ImageBitmap)
    return true;
  if (typeof OffscreenCanvas !== "undefined" && value instanceof OffscreenCanvas)
    return true;
  if (typeof ReadableStream !== "undefined" && value instanceof ReadableStream)
    return true;
  if (typeof WritableStream !== "undefined" && value instanceof WritableStream)
    return true;
  if (typeof TransformStream !== "undefined" && value instanceof TransformStream)
    return true;
  return false;
}

function walk(value: unknown, out: Set<TransferableValue>, seen: Set<object>): void {
  if (value === null || typeof value !== "object") return;

  if (value instanceof ArrayBuffer) {
    out.add(value);
    return;
  }
  if (ArrayBuffer.isView(value)) {
    // Transfer the backing buffer of a typed array / DataView. SharedArrayBuffer
    // is not transferable and is not `instanceof ArrayBuffer`, so it is skipped.
    const buffer = (value as ArrayBufferView).buffer;
    if (buffer instanceof ArrayBuffer) out.add(buffer);
    return;
  }
  if (isTransferableObject(value)) {
    out.add(value as TransferableValue);
    return;
  }

  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) walk(item, out, seen);
    return;
  }

  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto === Object.prototype || proto === null) {
    for (const key of Object.keys(value)) {
      walk((value as Record<string, unknown>)[key], out, seen);
    }
  }
}

/** Collect all transferable objects reachable from `args`. */
export function detectTransferables(args: unknown[]): TransferableValue[] {
  const out = new Set<TransferableValue>();
  walk(args, out, new Set());
  return [...out];
}
