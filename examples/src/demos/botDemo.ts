import { createRuntime } from "../../../src/index";
import type { VisualExample, VisualHandle, VisualSettings } from "../types";

/* ------------------------------------------------------------------ */
/* The work: A* pathfinding, chained into a multi-stop foraging route. */
/*                                                                     */
/* `planRoute` is the task. It is deliberately *self-contained*: the   */
/* A* helper lives inside its body rather than next to it in the       */
/* module. That is not a style choice — a helper referenced from the   */
/* outer scope would need `inject`, and `inject` cannot survive a       */
/* minifier here: the bundler renames the reference inside the task    */
/* body (`astar(...)` becomes `xt(...)`) but not the injected key, so   */
/* the worker would throw ReferenceError in a production build.        */
/* Keeping the task self-contained sidesteps the problem entirely, and */
/* lets the exact same function also run on the main thread below.     */
/* ------------------------------------------------------------------ */

interface Cell {
  x: number;
  y: number;
}
interface PlanCtx {
  walls: number[];
  cols: number;
  rows: number;
}

/**
 * One unit of work: a foraging route that visits several sugars in order.
 * Chaining the legs into a single task is deliberate — one ~0.7 ms job beats
 * four ~0.18 ms jobs, because every job also pays a message round trip.
 */
function planRoute(start: Cell, goals: Cell[], ctx: PlanCtx): number[] {
  const { walls, cols, rows } = ctx;
  const n = cols * rows;

  /** Flat path [x0,y0,x1,y1,...] from `from` to `goal`, or [] if unreachable. */
  const astar = (from: Cell, goal: Cell): number[] => {
    const startId = from.y * cols + from.x;
    const goalId = goal.y * cols + goal.x;

    const g = new Float64Array(n).fill(Infinity);
    const f = new Float64Array(n).fill(Infinity);
    const came = new Int32Array(n).fill(-1);
    const inOpen = new Uint8Array(n);
    const h = (x: number, y: number) => Math.abs(x - goal.x) + Math.abs(y - goal.y);

    g[startId] = 0;
    f[startId] = h(from.x, from.y);
    const open: number[] = [startId];
    inOpen[startId] = 1;
    const dirs = [1, 0, -1, 0, 0, 1, 0, -1];

    while (open.length > 0) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (f[open[i]] < f[open[bi]]) bi = i;
      const cur = open[bi];
      if (cur === goalId) break;
      open[bi] = open[open.length - 1];
      open.pop();
      inOpen[cur] = 0;

      const cx = cur % cols;
      const cy = (cur - cx) / cols;
      for (let k = 0; k < 8; k += 2) {
        const nx = cx + dirs[k];
        const ny = cy + dirs[k + 1];
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const nid = ny * cols + nx;
        if (walls[nid] === 1) continue;
        const t = g[cur] + 1;
        if (t < g[nid]) {
          came[nid] = cur;
          g[nid] = t;
          f[nid] = t + h(nx, ny);
          if (inOpen[nid] === 0) {
            open.push(nid);
            inOpen[nid] = 1;
          }
        }
      }
    }

    if (goalId !== startId && came[goalId] === -1) return [];
    // Walk parents goal -> start, collecting cell ids, then reverse the *id*
    // list (NOT the flat [x,y,...] array — reversing that element-wise would
    // swap x<->y on every pair).
    const ids: number[] = [];
    let c = goalId;
    while (c !== -1) {
      ids.push(c);
      c = came[c];
    }
    ids.reverse(); // start -> goal
    const path: number[] = [];
    for (const id of ids) path.push(id % cols, (id - (id % cols)) / cols);
    return path;
  };

  let cur = start;
  const route: number[] = [];
  for (const goal of goals) {
    const leg = astar(cur, goal);
    if (leg.length === 0) break; // unreachable: keep what we have
    // Skip the first cell of every leg after the first — it is the previous
    // leg's last cell and would otherwise be duplicated.
    for (let i = route.length === 0 ? 0 : 2; i < leg.length; i++) route.push(leg[i]);
    cur = goal;
  }
  return route;
}

/* ------------------------------------------------------------------ */
/* The runnable visual benchmark.                                     */
/* ------------------------------------------------------------------ */

interface Bot {
  cx: number; // current cell (integer) — authoritative position
  cy: number;
  fromX: number; // current move segment (cell -> adjacent cell)
  fromY: number;
  toX: number;
  toY: number;
  t: number; // 0..1 progress along the current segment
  moving: boolean;
  dir: number; // facing angle (radians) for the pac-man mouth
  color: string;
  path: number[]; // current route, flat [x0,y0,x1,y1,...]
  pi: number; // index of the next node to step onto
  pending: number[] | null; // a finished route, held until the bot reaches it
  pendingUntil: number; // ms deadline after which a held route is written off
  planning: boolean; // a route is in flight on the pool
  nextPlanAt: number; // ms timestamp of the next scheduled replan
  eaten: number;
}

const COLORS = [
  "#ffd23f", "#ff6b6b", "#4ecdc4", "#a29bfe", "#f78fb3",
  "#54a0ff", "#5fd36b", "#ff9f43", "#48dbfb", "#feca57",
  "#e17055", "#00d2d3", "#c8d6e5", "#ff6ec7",
];

const LOADS: Record<string, number> = { light: 60, heavy: 200, brutal: 450 };
const MAX_BOTS = 450;

function mountDemo(
  stage: HTMLElement,
  setStatus: (html: string) => void,
  settings: VisualSettings,
): VisualHandle {
  // Odd dimensions so a recursive-backtracker maze fills the whole board.
  const COLS = 99;
  const ROWS = 61;
  const SUGARS = 150; // kept topped up, so the load is steady and comparable
  const ROUTE = 4; // sugars planned per task call
  const REPLAN_MS = 250; // the world changes constantly, so routes go stale fast
  const SPEED = 6.5; // cells per second
  // Plan from a cell a couple of steps down the current route rather than from
  // where the bot stands right now. Those two cells are ~300 ms of slack, which
  // is what lets an asynchronous answer arrive before it is needed.
  const LOOKAHEAD = 2;
  const PENDING_TTL = 1500; // give up on a held route after this long
  // On the main thread we refuse to spend more than this per frame on planning.
  // Without a cap the page would stop responding; with it, the cost shows up as
  // lower FPS *and* skipped plans — which is exactly the real-world trade-off.
  const MAIN_BUDGET_MS = 40;

  const hostW = stage.clientWidth || 820;
  const cell = Math.max(5, Math.floor(hostW / COLS));
  const W = cell * COLS;
  const H = cell * ROWS;
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  const canvas = document.createElement("canvas");
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  stage.appendChild(canvas);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const n = COLS * ROWS;
  const idx = (x: number, y: number) => y * COLS + x;

  // --- Maze: recursive backtracker (perfect maze), then light braiding. ---
  // Start fully walled; carve corridors on odd cells. The result is one fully
  // connected component (every open cell reaches every other), so bots can
  // always find a path and never get boxed into an isolated pocket.
  const walls: number[] = new Array(n).fill(1);
  walls[idx(1, 1)] = 0;
  const carveStack: Array<[number, number]> = [[1, 1]];
  const jumps = [
    [2, 0],
    [-2, 0],
    [0, 2],
    [0, -2],
  ];
  while (carveStack.length > 0) {
    const [cx, cy] = carveStack[carveStack.length - 1];
    const options: Array<[number, number, number, number]> = [];
    for (const [dx, dy] of jumps) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx >= 1 && ny >= 1 && nx <= COLS - 2 && ny <= ROWS - 2 && walls[idx(nx, ny)] === 1) {
        options.push([dx, dy, nx, ny]);
      }
    }
    if (options.length === 0) {
      carveStack.pop();
      continue;
    }
    const [dx, dy, nx, ny] = options[(Math.random() * options.length) | 0];
    walls[idx(cx + dx / 2, cy + dy / 2)] = 0; // knock out the wall between
    walls[idx(nx, ny)] = 0;
    carveStack.push([nx, ny]);
  }

  // Braiding: open ~half of the dead-ends so the maze has loops. This gives bots
  // alternative routes (less single-file funnelling) and looks livelier.
  const ortho = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (let y = 1; y < ROWS - 1; y++) {
    for (let x = 1; x < COLS - 1; x++) {
      if (walls[idx(x, y)] === 1) continue;
      let openCount = 0;
      const wallNbrs: Array<[number, number]> = [];
      for (const [dx, dy] of ortho) {
        const nx = x + dx;
        const ny = y + dy;
        if (walls[idx(nx, ny)] === 0) openCount += 1;
        else if (nx > 0 && ny > 0 && nx < COLS - 1 && ny < ROWS - 1) wallNbrs.push([nx, ny]);
      }
      if (openCount === 1 && wallNbrs.length > 0 && Math.random() < 0.5) {
        const [nx, ny] = wallNbrs[(Math.random() * wallNbrs.length) | 0];
        walls[idx(nx, ny)] = 0;
      }
    }
  }

  // Every open cell is walkable and reachable (connected maze).
  const walkable: number[] = [];
  for (let i = 0; i < n; i++) if (walls[i] === 0) walkable.push(i);
  const randomCell = () => walkable[(Math.random() * walkable.length) | 0];

  // Pre-render the static maze once to an offscreen canvas.
  const maze = document.createElement("canvas");
  maze.width = W * dpr;
  maze.height = H * dpr;
  const mctx = maze.getContext("2d") as CanvasRenderingContext2D;
  mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mctx.fillStyle = "#0d1117";
  mctx.fillRect(0, 0, W, H);
  mctx.fillStyle = "#1b2740";
  for (let i = 0; i < n; i++) {
    if (walls[i] !== 1) continue;
    const x = (i % COLS) * cell;
    const y = ((i - (i % COLS)) / COLS) * cell;
    mctx.fillRect(x, y, cell, cell);
  }

  /* --- State ------------------------------------------------------- */

  const sugars = new Set<number>();
  const bots: Bot[] = [];
  let botCount = LOADS[settings.load] ?? LOADS.heavy;
  let mode: "workers" | "main" = settings.mode === "main" ? "main" : "workers";
  let planGen = 0; // bumped on mode change, so in-flight results are ignored
  let eaten = 0;

  const topUpSugar = () => {
    let guard = 0;
    while (sugars.size < SUGARS && guard++ < SUGARS * 4) sugars.add(randomCell());
  };
  topUpSugar();

  const resetBot = (bot: Bot, now: number) => {
    const c = randomCell();
    bot.cx = c % COLS;
    bot.cy = (c - bot.cx) / COLS;
    bot.fromX = bot.cx;
    bot.fromY = bot.cy;
    bot.toX = bot.cx;
    bot.toY = bot.cy;
    bot.t = 0;
    bot.moving = false;
    bot.path = [];
    bot.pi = 0;
    bot.pending = null;
    bot.pendingUntil = 0;
    bot.planning = false;
    // Stagger the first replan, otherwise every bot plans on the very same
    // frame and the demo opens with one huge stall.
    bot.nextPlanAt = now + Math.random() * REPLAN_MS;
  };

  const startedAt = performance.now();
  for (let i = 0; i < MAX_BOTS; i++) {
    const bot: Bot = {
      cx: 0, cy: 0, fromX: 0, fromY: 0, toX: 0, toY: 0,
      t: 0, moving: false, dir: 0,
      color: COLORS[i % COLORS.length],
      path: [], pi: 0, pending: null, pendingUntil: 0,
      planning: false, nextPlanAt: 0, eaten: 0,
    };
    resetBot(bot, startedAt);
    bots.push(bot);
  }

  /* --- Runtime ----------------------------------------------------- */

  const planCtx: PlanCtx = { walls, cols: COLS, rows: ROWS };
  const runtime = createRuntime({ maxWorkers: "auto", minWorkers: 2 });
  // The maze never changes, so it travels once per worker via `context`;
  // from then on each call only ships a start cell and a handful of goals.
  const plan = runtime.task(planRoute, { context: planCtx });

  let running = true;

  /* --- Measurements (reset every status tick) ----------------------- */

  let winCpuMs = 0; // main-thread ms spent on planning
  let winPlans = 0; // routes completed
  let winSkipped = 0; // routes not planned (budget) or thrown away (stale)
  let winRouteMs = 0; // main-mode only: time inside planRoute
  let winRouteCount = 0;
  let prevCompleted = 0;
  let prevTotalExec = 0;
  let mainBudgetLeft = MAIN_BUDGET_MS;

  /* --- Bot logic ---------------------------------------------------- */

  const dropPath = (bot: Bot) => {
    bot.path = [];
    bot.pi = 0;
  };

  /** The `want` nearest sugars to (cx,cy), closest first, skipping `taken`. */
  const nearestSugars = (cx: number, cy: number, taken: Set<number>, want: number): number[] => {
    const best: number[] = [];
    const bestD: number[] = [];
    for (const s of sugars) {
      if (taken.has(s)) continue;
      const sx = s % COLS;
      const d = Math.abs(sx - cx) + Math.abs((s - sx) / COLS - cy);
      let i = best.length;
      while (i > 0 && bestD[i - 1] > d) i -= 1;
      if (i >= want) continue;
      best.splice(i, 0, s);
      bestD.splice(i, 0, d);
      if (best.length > want) {
        best.pop();
        bestD.pop();
      }
    }
    return best;
  };

  /** Greedy chain of goals for one route: nearest, then nearest to that, ... */
  const pickGoals = (fromX: number, fromY: number): Cell[] => {
    const goals: Cell[] = [];
    const taken = new Set<number>();
    let cx = fromX;
    let cy = fromY;
    for (let k = 0; k < ROUTE; k++) {
      // A strict "nearest" rule makes hundreds of bots queue up behind the same
      // crumb, so the first leg picks at random among the three closest.
      const near = nearestSugars(cx, cy, taken, k === 0 ? 3 : 1);
      if (near.length === 0) break;
      const s = near[(Math.random() * near.length) | 0];
      taken.add(s);
      const sx = s % COLS;
      cx = sx;
      cy = (s - sx) / COLS;
      goals.push({ x: cx, y: cy });
    }
    return goals;
  };

  /**
   * Take on a finished route, if the bot has reached the cell it was planned
   * from. Called only while the bot stands exactly on a cell, so the test is
   * simply "does this route start right here".
   */
  const adoptPending = (bot: Bot, now: number) => {
    const route = bot.pending;
    if (route === null) return;
    if (route.length >= 4 && route[0] === bot.cx && route[1] === bot.cy) {
      bot.pending = null;
      bot.planning = false;
      bot.path = route;
      bot.pi = 1;
      return;
    }
    // Not there yet — keep holding it. Only write it off if the bot never
    // arrives: it lost its path, or the answer came back so late that it has
    // already walked past the anchor. Either way that is a wasted route.
    if (now >= bot.pendingUntil) {
      bot.pending = null;
      bot.planning = false;
      winSkipped += 1;
    }
  };

  /**
   * Plan a route anchored at (ax, ay) — the cell the bot will be standing on
   * when the answer can realistically arrive, i.e. the one it is stepping into.
   * Anchoring ahead instead of at the current cell is what makes the pool
   * usable: a worker round trip takes a few ms, a cell takes ~150 ms, so by the
   * time the route lands the bot is exactly where the route begins.
   */
  const requestPlan = (bot: Bot, now: number, ax: number, ay: number) => {
    const goals = pickGoals(ax, ay);
    if (goals.length === 0) return;
    const start = { x: ax, y: ay };
    bot.nextPlanAt = now + REPLAN_MS;
    bot.pendingUntil = now + PENDING_TTL;
    bot.planning = true;

    if (mode === "main") {
      if (mainBudgetLeft <= 0) {
        // No frame budget left: this bot keeps walking its stale route. That
        // is the cost of planning on the thread that also has to draw.
        bot.planning = false;
        winSkipped += 1;
        return;
      }
      const t0 = performance.now();
      const route = planRoute(start, goals, planCtx);
      const spent = performance.now() - t0;
      mainBudgetLeft -= spent;
      winCpuMs += spent;
      winRouteMs += spent;
      winRouteCount += 1;
      winPlans += 1;
      bot.pending = route;
      return;
    }

    const gen = planGen;
    // Dispatching still costs main-thread time (structured clone + bookkeeping),
    // so it is measured too — otherwise the comparison would be dishonest.
    const t0 = performance.now();
    const inFlight = plan(start, goals);
    winCpuMs += performance.now() - t0;
    inFlight
      .then((route) => {
        if (!running || gen !== planGen) return;
        const t1 = performance.now();
        winPlans += 1;
        bot.pending = route;
        winCpuMs += performance.now() - t1;
      })
      .catch(() => {
        if (!running || gen !== planGen) return;
        bot.planning = false;
        winSkipped += 1;
      });
  };

  // Runs on every cell the bot steps onto: it eats whatever sugar is there,
  // not just the piece it was heading for.
  const onReachCell = (bot: Bot) => {
    if (!sugars.delete(bot.cy * COLS + bot.cx)) return;
    bot.eaten += 1;
    eaten += 1;
  };

  const update = (bot: Bot, dt: number, now: number) => {
    // Travel budget for this frame, carried across cell boundaries so the bot
    // moves at a constant speed with no per-cell stutter.
    let budget = SPEED * dt;
    let guard = 0;
    while (budget > 0 && guard++ < 24) {
      if (bot.moving) {
        const remaining = 1 - bot.t;
        if (budget < remaining) {
          bot.t += budget;
          return;
        }
        budget -= remaining;
        bot.cx = bot.toX;
        bot.cy = bot.toY;
        bot.moving = false;
        bot.t = 0;
        onReachCell(bot);
      }

      // Stationary, exactly on a cell: the one moment a route can be swapped.
      adoptPending(bot, now);

      // Take the next step — but only if it is actually adjacent. This is the
      // hard guarantee against "teleport" jumps: if the route ever desyncs from
      // the real cell, we discard it and replan.
      let stepped = false;
      if (bot.pi * 2 + 1 < bot.path.length) {
        const nx = bot.path[bot.pi * 2];
        const ny = bot.path[bot.pi * 2 + 1];
        if (Math.abs(nx - bot.cx) + Math.abs(ny - bot.cy) === 1) {
          bot.pi += 1;
          bot.fromX = bot.cx;
          bot.fromY = bot.cy;
          bot.toX = nx;
          bot.toY = ny;
          bot.moving = true;
          bot.dir = Math.atan2(ny - bot.cy, nx - bot.cx);
          stepped = true;
        } else {
          dropPath(bot); // desynced route — throw it away
        }
      }

      // Replan when the route ran out, or on the timer: with hundreds of bots
      // eating each other's targets, a route a second old is already wrong.
      const nodes = bot.path.length / 2;
      const outOfRoute = bot.pi >= nodes;
      if (!bot.planning && (outOfRoute || now >= bot.nextPlanAt)) {
        // Anchor the request a couple of cells down the route the bot is
        // already committed to. `pi - 1` is the cell it is entering now.
        let ax = bot.cx;
        let ay = bot.cy;
        if (stepped) {
          const ai = Math.min(bot.pi - 1 + LOOKAHEAD, nodes - 1);
          ax = bot.path[ai * 2];
          ay = bot.path[ai * 2 + 1];
        }
        requestPlan(bot, now, ax, ay);
      }

      if (stepped) continue; // spend the remaining budget on this new segment
      return; // nothing to walk right now
    }
  };

  const step = (dt: number, now: number) => {
    mainBudgetLeft = MAIN_BUDGET_MS;
    topUpSugar();
    for (let i = 0; i < botCount; i++) update(bots[i], dt, now);
  };

  /* --- Render -------------------------------------------------------- */

  const render = (time: number) => {
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(maze, 0, 0, W, H);

    // sugar (little pink diamonds)
    const sr = Math.max(2, cell * 0.26);
    ctx.fillStyle = "#ff5db1";
    for (const s of sugars) {
      const px = ((s % COLS) + 0.5) * cell;
      const py = ((s - (s % COLS)) / COLS + 0.5) * cell;
      ctx.beginPath();
      ctx.moveTo(px, py - sr);
      ctx.lineTo(px + sr, py);
      ctx.lineTo(px, py + sr);
      ctx.lineTo(px - sr, py);
      ctx.closePath();
      ctx.fill();
    }

    // bots (pac-man)
    const r = cell * 0.46;
    for (let i = 0; i < botCount; i++) {
      const bot = bots[i];
      const rx = bot.moving ? bot.fromX + (bot.toX - bot.fromX) * bot.t : bot.cx;
      const ry = bot.moving ? bot.fromY + (bot.toY - bot.fromY) * bot.t : bot.cy;
      const px = (rx + 0.5) * cell;
      const py = (ry + 0.5) * cell;
      const mouth = (Math.sin(time * 10 + bot.eaten) * 0.5 + 0.5) * 0.3 + 0.04;
      ctx.fillStyle = bot.color;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.arc(px, py, r, bot.dir + mouth * Math.PI, bot.dir + (2 - mouth) * Math.PI);
      ctx.closePath();
      ctx.fill();
    }
  };

  /* --- Status line --------------------------------------------------- */

  const cls = (ok: boolean, bad: boolean) => (bad ? ' class="warn"' : ok ? ' class="good"' : "");

  const updateStatus = (fps: number, span: number) => {
    const cpuPerSec = (winCpuMs / span) * 1000;
    const plansPerSec = (winPlans / span) * 1000;
    const skippedPerSec = (winSkipped / span) * 1000;

    // What one route costs. These are deliberately different measurements and
    // are labelled as such: on the main thread it is CPU time, in pool mode the
    // runtime's own figure is wall-clock from dispatch to result — queueing and
    // two structured clones included — which is latency, not CPU.
    let routeMs = 0;
    let routeLabel = "route cost";
    let workers = "—";
    if (mode === "main") {
      routeMs = winRouteCount > 0 ? winRouteMs / winRouteCount : 0;
    } else {
      routeLabel = "round trip";
      const st = runtime.stats();
      const total = st.averageExecutionTime * st.completedJobs;
      const done = st.completedJobs - prevCompleted;
      if (done > 0) routeMs = (total - prevTotalExec) / done;
      prevCompleted = st.completedJobs;
      prevTotalExec = total;
      workers = String(st.workers);
    }

    setStatus(
      `<span>planning <b>${mode === "main" ? "main thread" : "worker pool"}</b></span>` +
        `<span>bots <b>${botCount}</b></span>` +
        `<span>FPS <b${cls(fps >= 50, fps < 30)}>${fps}</b></span>` +
        `<span>main-thread planning <b${cls(cpuPerSec < 100, cpuPerSec > 400)}>` +
        `${Math.round(cpuPerSec)} ms/s</b></span>` +
        `<span>routes <b>${Math.round(plansPerSec)}/s</b></span>` +
        `<span>${routeLabel} <b>${routeMs.toFixed(2)} ms</b></span>` +
        `<span>workers <b>${workers}</b></span>` +
        `<span>skipped <b${cls(skippedPerSec < 1, skippedPerSec > 50)}>` +
        `${Math.round(skippedPerSec)}/s</b></span>` +
        `<span>eaten <b>${eaten}</b></span>`,
    );

    winCpuMs = 0;
    winPlans = 0;
    winSkipped = 0;
    winRouteMs = 0;
    winRouteCount = 0;
  };

  /* --- Loop ---------------------------------------------------------- */

  let last = startedAt;
  let winStart = startedAt;
  let frames = 0;
  let raf = 0;

  const frame = (now: number) => {
    if (!running) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    step(dt, now);
    render(now / 1000);
    frames += 1;
    const span = now - winStart;
    if (span >= 500) {
      updateStatus(Math.round((frames * 1000) / span), span);
      frames = 0;
      winStart = now;
    }
    raf = requestAnimationFrame(frame);
  };
  updateStatus(0, 1000);
  raf = requestAnimationFrame(frame);

  return {
    stop: () => {
      running = false;
      cancelAnimationFrame(raf);
      void runtime.shutdown().catch(() => {});
    },
    apply: (next: VisualSettings) => {
      const wanted = next.mode === "main" ? "main" : "workers";
      if (wanted !== mode) {
        mode = wanted;
        planGen += 1; // results still in flight belong to the old mode
        for (const bot of bots) {
          bot.planning = false;
          bot.pending = null;
        }
      }
      const count = LOADS[next.load] ?? LOADS.heavy;
      if (count !== botCount) {
        const now = performance.now();
        for (let i = botCount; i < count; i++) resetBot(bots[i], now);
        botCount = count;
      }
    },
  };
}

const DEMO_CODE = `import { createRuntime } from "ahwork";

const runtime = createRuntime({ maxWorkers: "auto" });

// The maze never changes, so it travels once per worker via \`context\`;
// from then on each call only ships a start cell and a handful of goals.
const plan = runtime.task(planRoute, { context: { walls, cols, rows } });

// One unit of work = a whole foraging route (4 sugars, ~0.7 ms), not a single
// A* hop (~0.18 ms). Fewer, chunkier jobs is the whole game: every job pays a
// message round trip, so tiny jobs spend more on postage than on the work.
function planRoute(start, goals, ctx) {
  // Self-contained on purpose: the A* helper lives INSIDE the task body.
  // A helper sitting next to it in the module would need \`inject\`, and a
  // minifier renames the call site but not the injected key — so it would
  // throw ReferenceError in a production build.
  const astar = (from, goal) => { /* ...plain A* over ctx.walls... */ };

  let cur = start;
  const route = [];
  for (const goal of goals) {
    const leg = astar(cur, goal);
    if (leg.length === 0) break;
    for (let i = route.length === 0 ? 0 : 2; i < leg.length; i++) route.push(leg[i]);
    cur = goal;
  }
  return route;
}

// Each bot replans ~2.5x a second, because the other bots keep eating the
// sugar it was walking towards. That is the load: bots x 2.5 x 0.85 ms.
//
// The one trick worth stealing: plan from where the bot WILL be, not where it
// is. Anchoring two cells down the current route buys ~300 ms of slack, which
// is far more than a round trip needs — so the answer is always ready in time
// and nothing is thrown away. Anchor at the current cell instead and the bot
// has walked off before the route lands.
function requestPlan(bot) {
  const anchor = cellAhead(bot, 2);
  plan(anchor, pickGoals(anchor)).then((route) => {
    bot.pending = route; // adopted when the bot actually reaches \`anchor\`
  });
}

// Flip the switch above to run the exact same planRoute() on the main thread
// instead, and watch "main-thread planning" and FPS trade places.`;

export const botDemo: VisualExample = {
  id: "bots-sugar",
  title: "Parallel bot AI — pathfinding in workers",
  description:
    "Bots forage for sugar in a maze using plain A* (no neural nets). Each bot plans a multi-stop route, and that planning is the load. Use the switches to run it on the worker pool or on the main thread, and to turn the number of bots up until something gives — the status line shows how many milliseconds per second the main thread actually spends planning. Flipping a switch does not restart anything, so it is a true A/B on the same maze.",
  code: DEMO_CODE,
  controls: [
    {
      id: "mode",
      label: "Planning runs on",
      initial: "workers",
      options: [
        { value: "workers", label: "worker pool" },
        { value: "main", label: "main thread" },
      ],
    },
    {
      id: "load",
      label: "Bots",
      initial: "heavy",
      options: [
        { value: "light", label: "60" },
        { value: "heavy", label: "200" },
        { value: "brutal", label: "450" },
      ],
    },
  ],
  mount: mountDemo,
};
