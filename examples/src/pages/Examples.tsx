import { Layout } from "../components/Layout";
import { RunnableCard } from "../components/RunnableCard";
import { examples } from "../catalog";

export function Examples() {
  return (
    <Layout active="examples">
      <h1>Examples</h1>
      <p>
        Press <strong>Run</strong> on any card. Output appears below the code
        (and in the DevTools console). No Web Worker is touched directly.
      </p>
      {examples.map((example) => (
        <RunnableCard key={example.id} example={example} />
      ))}
    </Layout>
  );
}
