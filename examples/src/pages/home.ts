import { mountPage } from "../common";
import { homeExample, homePerfExample } from "../catalog";
import { createRunnableCard } from "../runnable";

const main = mountPage(
  "home",
  `
  <h1>AhWork</h1>
  <p class="lead">
    A small TypeScript runtime that runs CPU-heavy JavaScript on a pool of
    Web Workers. You write tasks; the library owns the workers.
  </p>
  <p>
    You never call <code>new Worker</code>, <code>postMessage</code>, or
    <code>onmessage</code>. AhWork creates workers on demand, reuses them,
    correlates messages with promises, and shuts the pool down cleanly.
  </p>
  <ul class="features">
    <li>Task-oriented API: <code>runtime.task(fn)</code>, then call it like an async function.</li>
    <li>On-demand pool: scales up to <code>maxWorkers</code>, down to <code>minWorkers</code>.</li>
    <li>Parallel <code>map()</code>, timeouts, <code>AbortSignal</code>, and runtime stats.</li>
    <li>Zero runtime dependencies. Browser-first.</li>
  </ul>
  <p>
    <a class="cta primary" href="/examples.html">Runnable examples</a>
    <a class="cta" href="/tutorial.html">Tutorial</a>
    <a class="cta" href="/docs.html">API reference</a>
  </p>
  <h2>Minimal example</h2>
  <p>The same idea as a hello-world: square a number off the main thread.</p>
  <div id="demo"></div>
  <h2>Why a pool</h2>
  <p>
    AhWork does not pick a random worker count. You set a floor and a ceiling
    (<code>minWorkers</code>…<code>maxWorkers</code>). Every job first tries an
    <strong>idle</strong> worker. Only if none is free and the pool is below
    the ceiling does it spawn. Extra jobs wait in a queue. After
    <code>idleTimeout</code> unused workers shrink back to the floor.
    One job is never faster in a worker — the win is parallelism and a free UI.
  </p>
  <div id="perf"></div>
  `,
);

main.querySelector("#demo")?.appendChild(createRunnableCard(homeExample));
main.querySelector("#perf")?.appendChild(createRunnableCard(homePerfExample));
