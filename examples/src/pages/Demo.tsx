import { Layout } from "../components/Layout";
import { VisualCard } from "../components/VisualCard";
import { botDemo } from "../demos/botDemo";

export function Demo() {
  return (
    <Layout active="demo">
      <h1>Demo: parallel bots in a game loop</h1>
      <p className="lead">
        An A/B switch, not a sales pitch — run the same pathfinding on the
        worker pool or on the main thread and read the numbers.
      </p>
      <p>
        Bots forage for sugar in a maze using plain <strong>A*</strong> (no
        neural nets). Each bot plans a route through four sugars at a time —
        roughly <b>0.85&nbsp;ms</b> of pure computation — and replans about two
        and a half times a second, because the other bots keep eating what it
        was walking towards. That is the whole load:{" "}
        <em>bots × 2.5 routes/sec × 0.85&nbsp;ms</em>. Nothing is faked to make
        it heavy; turn the bots up and it simply becomes more than one thread
        can do while also drawing 60 frames.
      </p>

      <VisualCard example={botDemo} />

      <h2>How to read it</h2>
      <p>
        The number that matters is <b>main-thread planning</b>: milliseconds out
        of every second of wall clock that the main thread actually burns on
        planning. There are only ~1000 of them in a second, and the canvas needs
        its share too.
      </p>
      <p>
        Rough figures from headless Chromium on an 8-thread laptop, averaged
        over a couple of runs — they move around by a third depending on what
        else the machine is doing. Yours will differ, which is rather the point
        of shipping the switch instead of a claim.
      </p>
      <table>
        <thead>
          <tr>
            <th>Bots</th>
            <th>Worker pool</th>
            <th>Main thread</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>60</td>
            <td>60 FPS, ~10 ms/s</td>
            <td>60 FPS, ~90 ms/s</td>
          </tr>
          <tr>
            <td>200</td>
            <td>60 FPS, ~15 ms/s</td>
            <td>56–60 FPS, ~280 ms/s</td>
          </tr>
          <tr>
            <td>450</td>
            <td>60 FPS, ~15 ms/s</td>
            <td>~30 FPS, ~700 ms/s</td>
          </tr>
        </tbody>
      </table>
      <p>
        So the honest summary is two-sided. At <b>60 bots</b> both modes hold
        60&nbsp;FPS and the pool wins nothing you could see — the work fits in
        the frame budget, and the round trips are pure overhead. At{" "}
        <b>450 bots</b> the same work costs the main thread around 700&nbsp;ms
        of every second and the frame rate halves, while the pool does it for
        roughly 15&nbsp;ms/s and never drops a frame. Workers are not a
        speed-up; they are a way to stop compute from landing on the thread that
        draws.
      </p>
      <p>
        <b>skipped</b> is the other half of the cost. In{" "}
        <code>main thread</code> mode the demo refuses to spend more than
        40&nbsp;ms per frame on planning — without that cap the page would stop
        responding to clicks. Bots that miss a slot keep walking a stale route,
        so the counter measures how much AI quality you are trading away to keep
        the frame alive. The real choice is never &quot;fast or slow&quot;, it
        is <em>drop frames, drop plans, or move the work</em>.
      </p>
      <p>
        <b>round trip</b> (pool mode) and <b>route cost</b> (main-thread mode)
        are deliberately different measurements, which is why they have
        different names. Route cost is CPU time. Round trip is wall clock from
        dispatch to resolved promise: two structured clones, the worker&apos;s
        compute, and the wait for the main thread to come back around to its
        message queue. It runs about 5&nbsp;ms here against 0.85&nbsp;ms of
        actual work — latency you do not pay for in throughput, but that you
        must design around.
      </p>

      <h2>Two things that make it work</h2>
      <p>
        <strong>One task is a whole route.</strong> A single A* hop costs about
        0.18&nbsp;ms, and a round trip is an order of magnitude more than that —
        ship one hop per message and you spend more on postage than on the work.
        Chaining four hops into one <code>planRoute</code> call makes the job
        ~0.85&nbsp;ms and the overhead a rounding error. If you take one design
        lesson from this page, take that one:{" "}
        <strong>a worker pool rewards fewer, chunkier jobs.</strong>
      </p>
      <p>
        <strong>Plan from where the bot will be, not where it is.</strong> An
        answer that arrives 5&nbsp;ms late is useless if you anchored it to the
        cell the bot was standing on, because the bot has moved. Each request is
        anchored two cells down the route the bot is already committed to —
        about 300&nbsp;ms of slack — and the result waits until the bot actually
        gets there. That single change took the demo from throwing away roughly
        two thirds of its routes to throwing away none. Asynchrony is not free;
        you pay for it in lookahead.
      </p>
      <p>
        The maze is sent to each worker once via <code>context</code>, so a call
        only carries a start cell and four goals. The task is also deliberately
        self-contained — its A* helper lives inside the function body rather
        than beside it in the module. That is the simplest answer to a real
        hazard this page turned up: a bundler renames the call site inside a
        task but not the key handed to <code>inject</code>. AhWork now detects
        and repairs that, but a task that needs nothing from outside cannot run
        into it at all.
      </p>
    </Layout>
  );
}
