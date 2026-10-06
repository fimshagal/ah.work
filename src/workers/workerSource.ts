/**
 * Source code of the generic worker runtime, stored as a string.
 *
 * It is turned into a Blob URL once per WorkerFactory and reused for every
 * worker instance. The worker maintains a task registry and speaks the typed
 * protocol from `protocol/messages.ts`.
 *
 * SECURITY: the worker reconstructs task functions from source text. Never pass
 * code assembled from untrusted/user input to `runtime.task(...)`. See plan.md.
 */
export const workerSource = String.raw`
"use strict";
var registry = new Map();
var contexts = new Map();

function serializeError(err) {
  if (err && typeof err === "object") {
    return {
      name: String(err.name || "Error"),
      message: String(err.message || err),
      stack: typeof err.stack === "string" ? err.stack : undefined,
    };
  }
  return { name: "Error", message: String(err) };
}

self.onmessage = async function (event) {
  var msg = event.data;
  var jobId = msg && msg.jobId;
  // Ignore malformed or foreign messages (forward-compatibility / robustness).
  if (!msg || typeof msg.type !== "string") return;
  try {
    if (msg.type === "REGISTER_TASK") {
      // Reconstruct the function from its source text. If helper functions were
      // injected, define them as locals first and close the task over them so it
      // can call them by name (same toString() serialization as the task).
      var fn;
      if (msg.inject) {
        var names = Object.keys(msg.inject);
        var body = "";
        for (var i = 0; i < names.length; i++) {
          body += "var " + names[i] + " = (" + msg.inject[names[i]] + ");\n";
        }
        body += "return (" + msg.source + ");";
        fn = new Function(body)();
      } else {
        fn = (0, eval)("(" + msg.source + ")");
      }
      registry.set(msg.taskId, fn);
      if (msg.hasContext) contexts.set(msg.taskId, msg.context);
      self.postMessage({ type: "TASK_REGISTERED", taskId: msg.taskId });
      return;
    }

    if (msg.type === "UNREGISTER_TASK") {
      registry.delete(msg.taskId);
      contexts.delete(msg.taskId);
      return;
    }

    if (msg.type === "EXECUTE") {
      var task = registry.get(msg.taskId);
      if (typeof task !== "function") {
        self.postMessage({
          type: "TASK_ERROR",
          jobId: jobId,
          error: { name: "RuntimeError", message: "Task not registered: " + msg.taskId },
        });
        return;
      }
      var args = msg.args || [];
      // Inject the cached context as the final argument, if the task has one.
      var callArgs = contexts.has(msg.taskId)
        ? args.concat([contexts.get(msg.taskId)])
        : args;
      var result = await task.apply(null, callArgs);
      self.postMessage({ type: "TASK_RESULT", jobId: jobId, result: result });
      return;
    }
  } catch (err) {
    self.postMessage({ type: "TASK_ERROR", jobId: jobId, error: serializeError(err) });
  }
};
`;
