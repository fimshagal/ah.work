import { highlight } from "../highlight";

/** A highlighted, non-runnable code block. */
export function CodeBlock({ code }: { code: string }) {
  return (
    <pre className="code">
      <code dangerouslySetInnerHTML={{ __html: highlight(code) }} />
    </pre>
  );
}
