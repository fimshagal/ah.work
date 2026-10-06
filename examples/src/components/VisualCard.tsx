import { useEffect, useRef, useState } from "react";
import { CodeBlock } from "./CodeBlock";
import type { VisualExample, VisualHandle, VisualSettings } from "../types";

const initialSettings = (example: VisualExample): VisualSettings =>
  Object.fromEntries((example.controls ?? []).map((c) => [c.id, c.initial]));

/** Same card chrome as RunnableCard, but Run mounts a live <canvas> stage. */
export function VisualCard({ example }: { example: VisualExample }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<VisualHandle | null>(null);
  const settingsRef = useRef<VisualSettings>(initialSettings(example));
  const [settings, setSettings] = useState<VisualSettings>(settingsRef.current);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");

  // The demo is imperative (canvas + requestAnimationFrame), so it is started
  // from an effect: by then React has committed the stage element, which means
  // it is visible and has a real width for the canvas to size against.
  // Returning the demo's own cleanup also stops it if the card unmounts.
  useEffect(() => {
    if (!running) return;
    const stage = stageRef.current;
    if (!stage) return;

    setStatus("starting…");
    try {
      const handle = example.mount(stage, setStatus, settingsRef.current);
      handleRef.current = handle;
      return () => {
        handleRef.current = null;
        handle.stop();
        stage.replaceChildren();
      };
    } catch (err) {
      setStatus(`ERROR: ${(err as Error).message}`);
      console.error(err);
      setRunning(false);
      return;
    }
  }, [running, example]);

  // Controls are pushed into the running demo rather than remounting it, so a
  // flip is an A/B test on the same maze, same bots, same frame.
  const setControl = (id: string, value: string) => {
    const next = { ...settingsRef.current, [id]: value };
    settingsRef.current = next;
    setSettings(next);
    handleRef.current?.apply(next);
  };

  return (
    <section className="card">
      <h2>{example.title}</h2>
      <p className="desc">{example.description}</p>
      <CodeBlock code={example.code} />
      <div className="actions">
        <button onClick={() => setRunning((on) => !on)}>
          {running ? "Stop" : "Run"}
        </button>
      </div>
      {running && (
        <div className="viz">
          {example.controls && example.controls.length > 0 && (
            <div className="viz-controls">
              {example.controls.map((control) => (
                <div className="viz-control" key={control.id}>
                  <span>{control.label}</span>
                  <div className="seg">
                    {control.options.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={
                          settings[control.id] === option.value ? "on" : ""
                        }
                        onClick={() => setControl(control.id, option.value)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div
            className="viz-status"
            dangerouslySetInnerHTML={{ __html: status }}
          />
          <div className="viz-stage" ref={stageRef} />
        </div>
      )}
    </section>
  );
}
