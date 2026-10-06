import { describe, it, expect } from "vitest";
import { detectTransferables } from "../src/utils/transferables";

describe("detectTransferables (P3 round 3)", () => {
  it("detects a bare ArrayBuffer", () => {
    const buf = new ArrayBuffer(8);
    expect(detectTransferables([buf])).toEqual([buf]);
  });

  it("detects the backing buffer of a typed array / DataView", () => {
    const u8 = new Uint8Array([1, 2, 3]);
    const dv = new DataView(new ArrayBuffer(4));
    expect(detectTransferables([u8])).toEqual([u8.buffer]);
    expect(detectTransferables([dv])).toEqual([dv.buffer]);
  });

  it("recurses into arrays and plain objects", () => {
    const a = new ArrayBuffer(2);
    const b = new ArrayBuffer(4);
    const found = detectTransferables([{ x: a, nested: [b] }]);
    expect(found).toContain(a);
    expect(found).toContain(b);
    expect(found).toHaveLength(2);
  });

  it("deduplicates repeated buffers", () => {
    const buf = new ArrayBuffer(8);
    const view = new Uint8Array(buf);
    expect(detectTransferables([buf, view, { again: buf }])).toEqual([buf]);
  });

  it("returns nothing for non-transferable values", () => {
    expect(detectTransferables([1, "s", true, null, { a: 1 }, [2, 3]])).toEqual(
      [],
    );
  });

  it("does not descend into class instances (e.g. Map/Date)", () => {
    const buf = new ArrayBuffer(8);
    const map = new Map([["k", buf]]);
    // A Map is skipped wholesale, so the buffer inside is not auto-transferred.
    expect(detectTransferables([map])).toEqual([]);
  });
});
