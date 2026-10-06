import type { MapInput, RunOptions, RuntimeTask } from "../types";

/** Function used by the runtime to submit a single job for a task. */
export type SubmitFn<A extends unknown[], R> = (
  args: A,
  options?: RunOptions,
) => Promise<Awaited<R>>;

/**
 * Build the callable task handle that exposes `task(...)`, `task.run(...)`
 * and `task.map(...)` over a single submit function.
 *
 * `argCount` is the task's declared callable arity (excluding an injected
 * context). It lets `map` decide how to turn each input into an argument list:
 *   - arity <= 1: each input is the single argument      -> `submit([input])`
 *   - arity >= 2: each input is the full argument tuple  -> `submit(input)`
 *
 * Results from `map` preserve input order regardless of completion order.
 */
export function createRuntimeTask<A extends unknown[], R>(
  submit: SubmitFn<A, R>,
  argCount: number,
  dispose: () => void = () => {},
): RuntimeTask<A, R> {
  const task = ((...args: A) => submit(args)) as RuntimeTask<A, R>;

  task.run = (args: A, options?: RunOptions) => submit(args, options);

  task.map = (inputs: MapInput<A>, options?: RunOptions) => {
    const list = inputs as unknown[];
    const pending = list.map((input) => {
      const args = (argCount <= 1 ? [input] : (input as unknown[])) as A;
      return submit(args, options);
    });
    return Promise.all(pending);
  };

  task.dispose = dispose;

  return task;
}
