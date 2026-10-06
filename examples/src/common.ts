// Shared UI helpers for the multi-page AhWork playground:
// syntax highlighting, the top navigation bar and global styles.

const KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "await", "async", "if", "else",
  "while", "for", "of", "in", "new", "try", "catch", "finally", "throw",
  "class", "extends", "implements", "interface", "type", "import", "from",
  "export", "typeof", "instanceof", "void", "yield", "do", "switch", "case",
  "break", "continue", "default", "delete", "as", "this",
]);
const LITERALS = new Set(["true", "false", "null", "undefined"]);
const TYPES = new Set([
  "number", "string", "boolean", "unknown", "any", "never", "object",
  "Promise", "Error", "RangeError", "Array", "ArrayBuffer", "Transferable",
]);

export function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;",
  );
}

/** Tiny dependency-free JS/TS syntax highlighter -> HTML string. */
export function highlight(code: string): string {
  const token =
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;
  let out = "";
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = token.exec(code)) !== null) {
    out += escapeHtml(code.slice(last, match.index));
    const [full, comment, str, num, ident] = match;

    if (comment !== undefined) {
      out += `<span class="tok-comment">${escapeHtml(comment)}</span>`;
    } else if (str !== undefined) {
      out += `<span class="tok-string">${escapeHtml(str)}</span>`;
    } else if (num !== undefined) {
      out += `<span class="tok-number">${escapeHtml(num)}</span>`;
    } else if (ident !== undefined) {
      const prevChar = code[match.index - 1];
      let j = token.lastIndex;
      while (j < code.length && (code[j] === " " || code[j] === "\t")) j += 1;
      const nextChar = code[j];

      let cls = "";
      if (KEYWORDS.has(ident)) cls = "tok-keyword";
      else if (LITERALS.has(ident)) cls = "tok-literal";
      else if (TYPES.has(ident)) cls = "tok-type";
      else if (nextChar === "(") cls = "tok-function";
      else if (prevChar === ".") cls = "tok-property";

      out += cls
        ? `<span class="${cls}">${escapeHtml(ident)}</span>`
        : escapeHtml(ident);
    } else {
      out += escapeHtml(full);
    }
    last = token.lastIndex;
  }

  out += escapeHtml(code.slice(last));
  return out;
}

/** A highlighted, non-runnable code block. */
export function codeBlock(code: string): string {
  return `<pre class="code"><code>${highlight(code)}</code></pre>`;
}

export type NavKey = "home" | "examples" | "tutorial" | "docs";

const NAV: { key: NavKey; href: string; label: string }[] = [
  { key: "home", href: "/index.html", label: "Home" },
  { key: "examples", href: "/examples.html", label: "Examples" },
  { key: "tutorial", href: "/tutorial.html", label: "Tutorial" },
  { key: "docs", href: "/docs.html", label: "API" },
];

/** Sticky top navigation with the active page highlighted. */
export function renderNav(active: NavKey): string {
  const links = NAV.map(
    (item) =>
      `<a href="${item.href}" class="${item.key === active ? "active" : ""}">${item.label}</a>`,
  ).join("");
  return `<nav class="topnav"><span class="brand">AhWork</span><div class="links">${links}</div></nav>`;
}

/** Render the shell (nav + main wrapper) into #app and return the <main>. */
export function mountPage(active: NavKey, mainHtml: string): HTMLElement {
  injectStyles();
  const app = document.getElementById("app");
  if (!app) throw new Error("#app not found");
  app.innerHTML = `${renderNav(active)}<main>${mainHtml}</main>`;
  return app.querySelector("main") as HTMLElement;
}

let stylesInjected = false;

export function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; margin: 0; line-height: 1.6; color: #1f2328; background: #ffffff; }
    @media (prefers-color-scheme: dark) { body { background: #0b0e14; color: #c9d1d9; } }
    a { color: #4f8cff; }

    .topnav { display: flex; align-items: center; gap: 24px; padding: 12px 24px; border-bottom: 1px solid #8883; position: sticky; top: 0; z-index: 10; background: #ffffffcc; backdrop-filter: blur(8px); }
    @media (prefers-color-scheme: dark) { .topnav { background: #0b0e14cc; } }
    .topnav .brand { font-weight: 700; font-size: 1.1rem; }
    .topnav .links { display: flex; gap: 18px; }
    .topnav a { text-decoration: none; color: inherit; opacity: 0.7; padding: 4px 2px; border-bottom: 2px solid transparent; }
    .topnav a:hover { opacity: 1; }
    .topnav a.active { opacity: 1; border-bottom-color: #4f8cff; font-weight: 600; }

    main { max-width: 880px; margin: 0 auto; padding: 28px 24px 72px; }
    main h1 { margin-top: 0; }
    h2 { margin-top: 2.2rem; }
    h3 { margin-top: 1.6rem; }
    p.lead { font-size: 1.15rem; opacity: 0.85; }
    ul.features { padding-left: 20px; }
    ul.features li { margin: 6px 0; }
    :not(pre) > code { background: #8881; padding: 1px 5px; border-radius: 5px; font-family: ui-monospace, monospace; font-size: 0.85em; }

    table { border-collapse: collapse; width: 100%; margin: 12px 0 22px; font-size: 0.9rem; }
    th, td { text-align: left; border: 1px solid #8883; padding: 8px 10px; vertical-align: top; }
    th { background: #8881; }
    td code { white-space: nowrap; }

    .cta { display: inline-block; margin: 6px 12px 6px 0; padding: 8px 16px; border-radius: 8px; border: 1px solid #8886; text-decoration: none; color: inherit; }
    .cta.primary { background: #4f8cff; color: #fff; border-color: #4f8cff; }

    .card { border: 1px solid #8883; border-radius: 12px; padding: 16px 20px; margin: 18px 0; }
    .card h2 { margin: 0 0 4px; font-size: 1.1rem; }
    .desc { margin: 0 0 12px; opacity: 0.75; }
    .actions { margin: 12px 0; }
    button { font: inherit; padding: 6px 16px; border-radius: 8px; border: 1px solid #8886; cursor: pointer; background: #4f8cff; color: #fff; }
    button:disabled { opacity: 0.6; cursor: default; }

    pre.code { background: #0d1117; padding: 14px 16px; border-radius: 8px; overflow-x: auto; border: 1px solid #30363d; margin: 0 0 12px; }
    pre.code code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem; color: #c9d1d9; background: none; padding: 0; }
    pre.output { background: #0d1117; color: #a7f3d0; padding: 12px 16px; border-radius: 8px; overflow-x: auto; font-size: 0.85rem; white-space: pre-wrap; border: 1px solid #30363d; }
    .tok-comment  { color: #8b949e; font-style: italic; }
    .tok-string   { color: #a5d6ff; }
    .tok-number   { color: #79c0ff; }
    .tok-keyword  { color: #ff7b72; }
    .tok-literal  { color: #ff7b72; }
    .tok-type     { color: #7ee787; }
    .tok-function { color: #d2a8ff; }
    .tok-property { color: #79c0ff; }
  `;
  document.head.appendChild(style);
}
