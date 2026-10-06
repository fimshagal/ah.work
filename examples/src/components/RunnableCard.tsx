import { useCallback, useRef, useState } from "react";
import { CodeBlock } from "./CodeBlock";
import { format, type Example, type Logger } from "../types";

/** Title, description, highlighted code, a Run button and a live output area. */
export function RunnableCard({ example }: { example: Example }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [running, setRunning] = useState(false);
  // Examples may log after an await, so collect into a ref and mirror to state.
  const buffer = useRef<string[]>([]);

  const onRun = useCallback(async () => {
    buffer.current = [];
    setLines([]);
    setRunning(true);

    const started = performance.now();
    const push = (text: string) => {
      buffer.current = [...buffer.current, text];
      setLines(buffer.current);
    };
    const log: Logger = (message) => {
      push(format(message));
      console.log(`[${example.id}]`, message);
    };

    try {
      await example.run(log);
      log(`done in ${(performance.now() - started).toFixed(1)} ms`);
    } catch (err) {
      push(`ERROR: ${(err as Error).message}`);
      console.error(err);
    } finally {
      setRunning(false);
    }
  }, [example]);

  return (
    <section className="card">
      <h2>{example.title}</h2>
      <p className="desc">{example.description}</p>
      <CodeBlock code={example.code} />
      <div className="actions">
        <button onClick={onRun} disabled={running}>
          Run
        </button>
      </div>
      {lines !== null && <pre className="output">{lines.join("\n")}</pre>}
    </section>
  );
}
