import { useState } from "react";
import { createRuntime } from "ahwork";

// Demo skeleton.
//
// TODO(demo phase):
//   - wire state through `tardigrade-store` (as used in our other projects)
//   - run a CPU-heavy task (Collatz) via runtime.task + task.map
//   - live-render runtime.stats(), worker count, and cancel/timeout/shutdown
//
// The demo intentionally never touches a Web Worker directly — only AhWork.

export function App() {
  const [ready] = useState(() => {
    // Runtime is created lazily; no workers spawn until work is submitted.
    createRuntime({ minWorkers: 0, maxWorkers: "auto", idleTimeout: 5000 });
    return true;
  });

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>AhWork demo</h1>
      <p>Skeleton ready: {String(ready)}.</p>
      <p>
        The compute pipeline (Collatz task, <code>map</code>, live stats,
        cancellation) will be wired here once the runtime is implemented.
      </p>
    </main>
  );
}
