/*
 * Vendored from affectUI 'Code Block (Clean)' — https://github.com/flohoeller/affectui @ 8f15236c790d3a21a668c98a663037e5219dd9c9
 * MIT License, Copyright (c) 2026 Florian Höller (adfects). Full text: ./LICENSE.
 * Adapted for BiVelio Savings; changes from upstream are listed in ./VENDOR.md.
 */
import "./code-block-clean.css";

/*
 * Code Block (Clean) – BiVelio keeps the ENGINE of the piece, not its shell.
 * Upstream is one client component: a framed figure with a header, a copy button and the code. In Savings the frame,
 * the header, the copy button (with its visible "Copied" confirmation), the line numbers and the expected-output
 * footer belong to the foundation `CodeFrame`, so shipping a second frame would only duplicate them. What is used
 * from upstream is what `CodeFrame` did not have: the tiny built-in colorizer for TypeScript / JavaScript, JSON,
 * Bash and Python (no highlighter to install; every other language is plain text) and the marked line.
 *
 * `CodeLines` renders the lines of one snippet with the upstream markup (`ui-codec__line`, `ui-codec__t-*`). It has
 * no state and no effects, so it renders on the server and ships no JavaScript. Put it inside `<CodeFrame>`.
 * The styles live in the sibling .css file (moved out of the upstream <style> string).
 */

export type CodeLinesProps = {
  /** The code – shown exactly as given (one trailing newline is dropped, as files end with one) */
  code: string;
  /** ts, tsx, js, jsx, json, bash, sh, python … – colors the code when known, otherwise plain text */
  language?: string;
  /** Lines to mark, counted from 1 – e.g. [3, 4, 5] */
  highlightLines?: number[];
  className?: string;
};

type Kind = "com" | "str" | "kw" | "num" | "lit" | "fn" | "key" | "var";
type Token = [Kind | null, string];

/** The lines of `code`, each a list of [kind, text] tokens – `kind` is null for plain text */
export function colorize(code: string, language?: string): Token[][] {
  const source = typeof code === "string" ? code : code == null ? "" : String(code);
  const shown = source.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  return toLines(tokenize(shown, resolve(language)));
}

export function CodeLines({ code, language, highlightLines, className }: CodeLinesProps) {
  const lines = colorize(code, language);
  const marked = new Set(Array.isArray(highlightLines) ? highlightLines : []);
  return (
    <code className={["ui-codec__code", className].filter(Boolean).join(" ")} dir="ltr" data-language={resolve(language) ?? undefined}>
      {lines.map((line, i) => (
        <span key={i} className="ui-codec__line" data-marked={marked.has(i + 1) || undefined}>
          {line.map(([kind, text], j) =>
            kind ? (
              <span key={j} className={`ui-codec__t-${kind}`}>
                {text}
              </span>
            ) : (
              text
            ),
          )}
          {i < lines.length - 1 ? "\n" : null}
        </span>
      ))}
    </code>
  );
}

/* ---------- The colorizer ---------- */

type Lang = "js" | "json" | "bash" | "python";

const ALIASES: Record<string, Lang> = {
  ts: "js", tsx: "js", typescript: "js", js: "js", jsx: "js", javascript: "js", mjs: "js", cjs: "js",
  json: "json", jsonc: "json",
  bash: "bash", sh: "bash", shell: "bash", zsh: "bash", console: "bash",
  python: "python", py: "python",
};

const resolve = (language?: string): Lang | null => (language ? ALIASES[language.toLowerCase()] ?? null : null);

const END = "(?![\\s\\S])";
const BLOCK_COMMENT = `\\/\\*[\\s\\S]*?(?:\\*\\/|${END})`;

/** Each language: [kind, pattern] in order – at one spot the first that matches wins */
const RULES: Record<Lang, [Kind, string][]> = {
  js: [
    ["com", `\\/\\/[^\\n]*|${BLOCK_COMMENT}`],
    ["str", `"(?:[^"\\\\\\n]|\\\\.)*"?|'(?:[^'\\\\\\n]|\\\\.)*'?|\`(?:[^\`\\\\]|\\\\[\\s\\S])*\`?`],
    ["num", `\\b0[xXbBoO][\\da-fA-F_]+n?\\b|\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?n?\\b`],
    ["lit", `\\b(?:true|false|null|undefined|NaN|Infinity)\\b`],
    [
      "kw",
      `\\b(?:abstract|as|async|await|break|case|catch|class|const|continue|debugger|declare|default|delete|do|else|enum|export|extends|finally|for|from|function|if|implements|import|in|instanceof|interface|keyof|let|new|of|private|protected|public|readonly|return|satisfies|static|super|switch|this|throw|try|type|typeof|var|void|while|with|yield)\\b`,
    ],
    ["fn", `(?<![\\w$])[A-Za-z_$][\\w$]*(?=\\s*\\()`],
  ],
  json: [
    ["com", `\\/\\/[^\\n]*|${BLOCK_COMMENT}`],
    ["key", `"(?:[^"\\\\\\n]|\\\\.)*"(?=\\s*:)`],
    ["str", `"(?:[^"\\\\\\n]|\\\\.)*"?`],
    ["num", `-?\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b`],
    ["lit", `\\b(?:true|false|null)\\b`],
  ],
  bash: [
    ["com", `(?<![^\\s;|&(])#[^\\n]*`],
    ["str", `"(?:[^"\\\\]|\\\\[\\s\\S])*"?|'[^']*'?`],
    ["var", `\\$\\{[^}\\n]*\\}?|\\$[A-Za-z_]\\w*|\\$[0-9@#?*$!-]`],
    ["kw", `\\b(?:if|then|else|elif|fi|for|in|do|done|while|until|case|esac|function|return|export|local|readonly|unset|exit)\\b`],
    // The command: the first word of a line or after a pipe, ;, && or $( – but not NAME=value
    ["fn", `(?<=^[ \\t]*|[|;&(][ \\t]*)[A-Za-z_.\\/~][\\w.\\/~+-]*(?![\\w=])`],
  ],
  python: [
    ["com", `#[^\\n]*`],
    [
      "str",
      `(?:\\b[rRbBuUfF]{1,2})?(?:"""[\\s\\S]*?(?:"""|${END})|'''[\\s\\S]*?(?:'''|${END})|"(?:[^"\\\\\\n]|\\\\.)*"?|'(?:[^'\\\\\\n]|\\\\.)*'?)`,
    ],
    ["fn", `@[A-Za-z_][\\w.]*`],
    ["num", `\\b0[xXoObB][\\da-fA-F_]+\\b|\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?j?\\b`],
    ["lit", `\\b(?:True|False|None|self|cls)\\b`],
    [
      "kw",
      `\\b(?:and|as|assert|async|await|break|case|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|match|nonlocal|not|or|pass|raise|return|try|while|with|yield)\\b`,
    ],
    ["fn", `\\b[A-Za-z_]\\w*(?=\\s*\\()`],
  ],
};

const compiled = new Map<Lang, { re: RegExp; kinds: Kind[] }>();
function grammar(lang: Lang) {
  let g = compiled.get(lang);
  if (!g) {
    const rules = RULES[lang];
    g = { re: new RegExp(rules.map(([, p]) => `(${p})`).join("|"), "gm"), kinds: rules.map(([k]) => k) };
    compiled.set(lang, g);
  }
  return g;
}

function tokenize(text: string, lang: Lang | null): Token[] {
  if (!lang || !text) return [[null, text]];
  const { re, kinds } = grammar(lang);
  re.lastIndex = 0;
  const out: Token[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!m[0]) {
      re.lastIndex++;
      continue;
    }
    if (m.index > last) out.push([null, text.slice(last, m.index)]);
    const group = m.findIndex((g, i) => i > 0 && g !== undefined);
    out.push([kinds[group - 1] ?? null, m[0]]);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push([null, text.slice(last)]);
  return out;
}

/** Splits the tokens into lines – a comment or string that runs over several lines keeps its color on each */
function toLines(tokens: Token[]): Token[][] {
  const lines: Token[][] = [[]];
  for (const [kind, text] of tokens) {
    text.split("\n").forEach((part, i) => {
      if (i) lines.push([]);
      if (part) lines[lines.length - 1].push([kind, part]);
    });
  }
  return lines;
}
