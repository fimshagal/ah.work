import { describe, it, expect } from "vitest";
import { createRuntimeTask, type SubmitFn } from "../src/runtime/RuntimeTask";

describe("RuntimeTask.map (phase 5)", () => {
  it("maps single-argument inputs (arity 1)", async () => {
    const submit: SubmitFn<[number], number> = (args) =>
      Promise.resolve(args[0] * args[0]);
    const task = createRuntimeTask(submit, 1);

    expect(await task.map([1, 2, 3, 4, 5])).toEqual([1, 4, 9, 16, 25]);
  });

  it("maps multi-argument tuples (arity 2)", async () => {
    const submit: SubmitFn<[number, number], number> = (args) =>
      Promise.resolve(args[0] + args[1]);
    const task = createRuntimeTask(submit, 2);

    expect(
      await task.map([
        [1, 2],
        [10, 20],
        [100, 200],
      ]),
    ).toEqual([3, 30, 300]);
  });

  it("treats each input as the single arg when arity is 1, even if it is an array", async () => {
    const submit: SubmitFn<[number[]], number> = (args) =>
      Promise.resolve(args[0].length);
    const task = createRuntimeTask(submit, 1);

    expect(
      await task.map([
        [1, 2, 3],
        [4, 5],
      ]),
    ).toEqual([3, 2]);
  });

  it("preserves input order regardless of completion order", async () => {
    const submit: SubmitFn<[number], number> = (args) =>
      new Promise((resolve) =>
        // earlier inputs resolve later
        setTimeout(() => resolve(args[0]), args[0] === 1 ? 30 : 1),
      );
    const task = createRuntimeTask(submit, 1);

    expect(await task.map([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("run() and the callable form forward args to submit", async () => {
    const calls: unknown[][] = [];
    const submit: SubmitFn<[number, number], number> = (args) => {
      calls.push(args);
      return Promise.resolve(args[0] * args[1]);
    };
    const task = createRuntimeTask(submit, 2);

    expect(await task(3, 4)).toBe(12);
    expect(await task.run([5, 6])).toBe(30);
    expect(calls).toEqual([
      [3, 4],
      [5, 6],
    ]);
  });
});
