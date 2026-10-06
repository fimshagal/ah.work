import { mountPage } from "../common";
import { examples } from "../catalog";
import { createRunnableCard } from "../runnable";

const main = mountPage(
  "examples",
  `
  <h1>Examples</h1>
  <p>
    Press <strong>Run</strong> on any card. Output appears below the code
    (and in the DevTools console). No Web Worker is touched directly.
  </p>
  <div id="cards"></div>
  `,
);

const cards = main.querySelector("#cards") as HTMLElement;
for (const example of examples) {
  cards.appendChild(createRunnableCard(example));
}
