import { highlight } from "./common";

export type Logger = (message: unknown) => void;

export interface Example {
  id: string;
  title: string;
  /** The "example" section: what this demonstrates. */
  description: string;
  /** The exact code that runs when you press "Run". */
  code: string;
  run: (log: Logger) => Promise<void>;
}

export function format(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Build a runnable example card: title, description, highlighted code,
 *  a Run button and a live output area. */
export function createRunnableCard(example: Example): HTMLElement {
  const card = document.createElement("section");
  card.className = "card";
  card.innerHTML = `
    <h2>${example.title}</h2>
    <p class="desc">${example.description}</p>
    <pre class="code"><code></code></pre>
    <div class="actions"><button>Run</button></div>
    <pre class="output" hidden></pre>
  `;
  (card.querySelector("code") as HTMLElement).innerHTML = highlight(
    example.code,
  );

  const button = card.querySelector("button") as HTMLButtonElement;
  const output = card.querySelector(".output") as HTMLPreElement;

  button.addEventListener("click", async () => {
    output.hidden = false;
    output.textContent = "";
    button.disabled = true;
    const started = performance.now();
    const log: Logger = (message) => {
      output.textContent += `${format(message)}\n`;
      console.log(`[${example.id}]`, message);
    };
    try {
      await example.run(log);
      log(`done in ${(performance.now() - started).toFixed(1)} ms`);
    } catch (err) {
      output.textContent += `ERROR: ${(err as Error).message}\n`;
      console.error(err);
    } finally {
      button.disabled = false;
    }
  });

  return card;
}
