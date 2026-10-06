import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * Mount a page into #app.
 *
 * StrictMode is deliberately omitted: the Demo page starts an imperative
 * canvas loop and a real worker pool from an effect, and double-invoking that
 * in development would spawn a second pool just to tear it down again.
 */
export function mount(element: ReactElement): void {
  const container = document.getElementById("app");
  if (!container) throw new Error("#app not found");
  createRoot(container).render(element);
}
