// Tiny dependency-free JS/TS syntax highlighter.
// It produces an HTML string, which <CodeBlock> renders via
// dangerouslySetInnerHTML — the input is always our own literal source text.

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
