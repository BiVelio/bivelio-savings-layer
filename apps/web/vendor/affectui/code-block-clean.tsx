/*
 * Vendored from affectUI 'Code Block (Clean)' — https://github.com/flohoeller/affectui @ 8f15236c790d3a21a668c98a663037e5219dd9c9
 * MIT License, Copyright (c) 2026 Florian Höller (adfects). Full text: ./LICENSE.
 * Adapted for BiVelio Savings; changes from upstream are listed in ./VENDOR.md.
 */
"use client";

import "./code-block-clean.css";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";

/*
 * Code Block (Clean) – a single self-contained file.
 * Code on a faint panel with a hairline: a header with the file name (or the language) and a copy button that turns
 * into a check for a moment. Optional line numbers that stay put while long lines scroll sideways, highlighted lines,
 * wrapping instead of scrolling, and a max height after which the code scrolls inside.
 * A tiny built-in colorizer for TypeScript / JavaScript, JSON, Bash and Python – no highlighter to install;
 * every other language is shown as plain text.
 * The styles live in the sibling .css file (moved out of the upstream <style> string).
 */

export type CodeBlockProps = {
  /** The code – copied exactly as given */
  code: string;
  /** ts, tsx, js, jsx, json, bash, sh, python … – colors the code when known, otherwise plain text */
  language?: string;
  /** Shown in the header, e.g. "agent.config.ts" – without it the header names the language */
  filename?: string;
  /** Numbers in front of every line, they stay in place while the code scrolls sideways */
  showLineNumbers?: boolean;
  /** Lines to mark, counted from 1 – e.g. [3, 4, 5] */
  highlightLines?: number[];
  /** Long lines wrap instead of scrolling sideways */
  wrap?: boolean;
  /** After this height the code scrolls inside, e.g. 320 or "40vh" */
  maxHeight?: number | string;
  /** The copy button in the header. BiVelio: shown only when `labels` is given – the kit ships no English strings */
  copyable?: boolean;
  /** BiVelio: translated names for the copy button and the scroll region (e.g. from the `ui` namespace) */
  labels?: { copy: string; copied: string; code?: string };
  /** Called after the code was copied – e.g. for a toast */
  onCopy?: (code: string) => void;
  className?: string;
  style?: CSSProperties;
};

type Kind = "com" | "str" | "kw" | "num" | "lit" | "fn" | "key" | "var";
type Token = [Kind | null, string];

export function CodeBlock({
  code,
  language,
  filename,
  showLineNumbers = false,
  highlightLines,
  wrap = false,
  maxHeight,
  copyable = true,
  labels,
  onCopy,
  className,
  style,
}: CodeBlockProps) {
  // One trailing newline is how files end – it shouldn't show as an empty last line
  const source = typeof code === "string" ? code : code == null ? "" : String(code);
  const shown = source.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  const lang = resolve(language);
  const lines = useMemo(() => toLines(tokenize(shown, lang)), [shown, lang]);
  const marked = useMemo(() => new Set(Array.isArray(highlightLines) ? highlightLines : []), [highlightLines]);
  const label = filename || languageName(language);

  const scroller = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  const [copied, setCopied] = useState(false);

  // A scrolling block is reachable by Tab, so keyboard users can scroll it with the arrow keys
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const check = () => setScrolls(el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [shown, wrap, maxHeight, showLineNumbers]);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(t);
  }, [copied]);

  const copy = () =>
    copyText(source).then((ok) => {
      if (!ok) return;
      setCopied(true);
      onCopy?.(source);
    });

  const canCopy = copyable && !!labels;
  const header = !!label || canCopy;
  const digits = String(lines.length).length;

  return (
    <figure
      className={["ui-codec", className].filter(Boolean).join(" ")}
      data-wrap={wrap || undefined}
      data-numbers={showLineNumbers || undefined}
      style={{ ...style, ["--ui-codec-digits" as string]: digits }}
    >
      {header && (
        <figcaption className="ui-codec__head">
          <span className="ui-codec__label" dir="auto" title={label || undefined}>
            {label}
          </span>
          {canCopy && (
            <button
              type="button"
              className="ui-codec__copy"
              data-copied={copied || undefined}
              aria-label={copied ? labels.copied : labels.copy}
              title={copied ? labels.copied : labels.copy}
              onClick={copy}
            >
              <svg className="ui-codec__copy-icon" viewBox="0 0 16 16" aria-hidden="true">
                <rect x="5.5" y="5.5" width="8.5" height="8.5" rx="2" />
                <path d="M10.5 3.75v-.25A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h.25" />
              </svg>
              <svg className="ui-codec__copy-done" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3.5 8.4 6.6 11.3 12.5 4.9" />
              </svg>
            </button>
          )}
        </figcaption>
      )}
      {/* Screen readers hear the copy – the button's new name alone isn't announced */}
      {canCopy && (
        <span className="ui-codec__sr" role="status">
          {copied ? labels.copied : ""}
        </span>
      )}
      <div
        ref={scroller}
        className="ui-codec__scroll"
        style={maxHeight != null ? { maxHeight } : undefined}
        tabIndex={scrolls ? 0 : undefined}
        role={scrolls ? "region" : undefined}
        aria-label={scrolls ? label || labels?.code || undefined : undefined}
      >
        <pre className="ui-codec__pre" dir="ltr">
          <code className="ui-codec__code">
            {lines.map((line, i) => (
              <span key={i} className="ui-codec__line" data-marked={marked.has(i + 1) || undefined}>
                {showLineNumbers && (
                  <span className="ui-codec__ln" aria-hidden="true">
                    {i + 1}
                  </span>
                )}
                <span className="ui-codec__text">
                  {line.map(([kind, text], j) =>
                    kind ? (
                      <span key={j} className={`ui-codec__t-${kind}`}>
                        {text}
                      </span>
                    ) : (
                      text
                    ),
                  )}
                </span>
              </span>
            ))}
          </code>
        </pre>
      </div>
    </figure>
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

const NAMES: Record<string, string> = {
  ts: "TypeScript", typescript: "TypeScript", tsx: "TSX", js: "JavaScript", javascript: "JavaScript", jsx: "JSX",
  mjs: "JavaScript", cjs: "JavaScript", json: "JSON", jsonc: "JSON", bash: "Bash", sh: "Shell", shell: "Shell",
  zsh: "Zsh", console: "Terminal", python: "Python", py: "Python",
};

const resolve = (language?: string): Lang | null => (language ? ALIASES[language.toLowerCase()] ?? null : null);
const languageName = (language?: string) => (language ? NAMES[language.toLowerCase()] ?? language : "");

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

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers and non-secure contexts
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}
