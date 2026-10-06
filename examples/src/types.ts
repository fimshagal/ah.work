export type Logger = (message: unknown) => void;

/** A runnable example: press Run, see text output under the code. */
export interface Example {
  id: string;
  title: string;
  /** The "example" section: what this demonstrates. */
  description: string;
  /** The exact code that runs when you press "Run". */
  code: string;
  run: (log: Logger) => Promise<void>;
}

/** One segmented switch rendered above a running visual demo. */
export interface VisualControl {
  id: string;
  label: string;
  options: Array<{ value: string; label: string }>;
  initial: string;
}

/** The current value of every control, keyed by control id. */
export type VisualSettings = Record<string, string>;

/** What a visual demo hands back so the card can drive and stop it. */
export interface VisualHandle {
  /** Stop the loop and release resources (workers, timers, canvases). */
  stop: () => void;
  /**
   * Apply new control values to the *running* demo. Switching a control must
   * not restart anything — the whole point is to watch the numbers change
   * live, on the next frame.
   */
  apply: (settings: VisualSettings) => void;
}

/** A visual example: same card chrome, but Run mounts a live <canvas> stage. */
export interface VisualExample {
  id: string;
  title: string;
  description: string;
  code: string;
  /** Switches shown above the stage while the demo runs. */
  controls?: VisualControl[];
  /**
   * Start the demo inside `stage`. `setStatus` updates a small status line.
   * `settings` holds the initial value of every control.
   */
  mount: (
    stage: HTMLElement,
    setStatus: (html: string) => void,
    settings: VisualSettings,
  ) => VisualHandle;
}

export function format(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
