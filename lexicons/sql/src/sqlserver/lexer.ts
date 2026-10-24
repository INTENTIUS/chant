/**
 * A T-SQL tokenizer for the statements `chant import` reads from SQL Server.
 *
 * T-SQL differs from the lexers the other dialects use in four places: an
 * identifier can be `[bracketed]` (a `]` inside is written `]]`) or
 * "double quoted", a string can carry an `N` prefix, a line holding only `GO`
 * ends a batch (it is a client command, not a statement), and statements need
 * no terminating `;`. Comments (`--` and nestable `/* *\/`) are dropped; each
 * token keeps its 1-based line and column in the source.
 */

export type TokenKind = "word" | "qident" | "string" | "number" | "variable" | "punct" | "go";

export interface Token {
  kind: TokenKind;
  /** As written: a `qident` keeps its brackets; a string its quotes. */
  text: string;
  /** A `qident`'s name, a string's value, a word's text. */
  value: string;
  line: number;
  column: number;
  /** Offset of the first character. */
  start: number;
  /** Offset after the last. */
  end: number;
}

export class TsqlLexError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(`${message} (line ${String(line)}, column ${String(column)})`);
    this.name = "TsqlLexError";
  }
}

const WORD_START = /[A-Za-z_#@\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_#$@\u0080-￿]/;

/** Tokenize a file. A `GO` on a line of its own (optionally with a count) becomes one `go` token. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const n = text.length;
  // A byte order mark starts files saved by SSMS and Visual Studio.
  if (text.charCodeAt(0) === 0xfeff) {
    i = 1;
    lineStart = 1;
  }
  const push = (kind: TokenKind, start: number, end: number, value: string, startLine: number, startCol: number) =>
    tokens.push({ kind, text: text.slice(start, end), value, line: startLine, column: startCol, start, end });

  while (i < n) {
    const c = text[i]!;
    if (c === "\n") {
      line++;
      i++;
      lineStart = i;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const col = i - lineStart + 1;
    if (c === "-" && text[i + 1] === "-") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      let depth = 1;
      const startLine = line;
      const startCol = col;
      i += 2;
      while (i < n && depth > 0) {
        if (text[i] === "/" && text[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (text[i] === "*" && text[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          if (text[i] === "\n") {
            line++;
            lineStart = i + 1;
          }
          i++;
        }
      }
      if (depth > 0) throw new TsqlLexError("unterminated /* comment", startLine, startCol);
      continue;
    }
    if (c === "[") {
      const start = i;
      let value = "";
      i++;
      for (;;) {
        if (i >= n) throw new TsqlLexError("unterminated [identifier]", line, col);
        if (text[i] === "]") {
          if (text[i + 1] === "]") {
            value += "]";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        if (text[i] === "\n") {
          line++;
          lineStart = i + 1;
        }
        value += text[i];
        i++;
      }
      push("qident", start, i, value, line, col);
      continue;
    }
    if (c === '"') {
      const start = i;
      let value = "";
      i++;
      for (;;) {
        if (i >= n) throw new TsqlLexError('unterminated "identifier"', line, col);
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            value += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += text[i];
        i++;
      }
      push("qident", start, i, value, line, col);
      continue;
    }
    if (c === "'" || ((c === "N" || c === "n") && text[i + 1] === "'")) {
      const start = i;
      const startLine = line;
      if (c !== "'") i++;
      i++;
      let value = "";
      for (;;) {
        if (i >= n) throw new TsqlLexError("unterminated string", startLine, col);
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        if (text[i] === "\n") {
          line++;
          lineStart = i + 1;
        }
        value += text[i];
        i++;
      }
      push("string", start, i, value, startLine, col);
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
      const start = i;
      if (c === "0" && (text[i + 1] === "x" || text[i + 1] === "X")) {
        i += 2;
        while (i < n && /[0-9A-Fa-f]/.test(text[i]!)) i++;
      } else {
        while (i < n && /[0-9]/.test(text[i]!)) i++;
        if (text[i] === "." ) {
          i++;
          while (i < n && /[0-9]/.test(text[i]!)) i++;
        }
        if ((text[i] === "e" || text[i] === "E") && /[0-9+-]/.test(text[i + 1] ?? "")) {
          i += 2;
          while (i < n && /[0-9]/.test(text[i]!)) i++;
        }
      }
      push("number", start, i, text.slice(start, i), line, col);
      continue;
    }
    if (c === "@" && text[i + 1] !== undefined && WORD_PART.test(text[i + 1]!)) {
      const start = i;
      i++;
      while (i < n && WORD_PART.test(text[i]!)) i++;
      push("variable", start, i, text.slice(start, i), line, col);
      continue;
    }
    if (WORD_START.test(c)) {
      const start = i;
      i++;
      while (i < n && WORD_PART.test(text[i]!)) i++;
      const word = text.slice(start, i);
      push("word", start, i, word, line, col);
      continue;
    }
    // Two-character operators are one token so a `<>` is not a `<` and a `>`.
    const two = text.slice(i, i + 2);
    if (["<>", ">=", "<=", "!=", "+=", "-=", "*=", "/=", "||", "::"].includes(two)) {
      push("punct", i, i + 2, two, line, col);
      i += 2;
      continue;
    }
    push("punct", i, i + 1, c, line, col);
    i++;
  }
  return markBatchSeparators(tokens, text);
}

/** `GO` alone on its line (or `GO 5`) is a separator, not a word. */
function markBatchSeparators(tokens: Token[], text: string): Token[] {
  const out: Token[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.kind === "word" && t.value.toUpperCase() === "GO") {
      const prev = tokens[k - 1];
      const next = tokens[k + 1];
      const alone = (a: Token | undefined) => a === undefined || a.line !== t.line;
      const count = next && next.kind === "number" && next.line === t.line ? next : undefined;
      const after = count ? tokens[k + 2] : next;
      // The line before `GO` ends the earlier statement, and a `GO` mid-line is a name.
      if (alone(prev) && alone(after) && !/[A-Za-z0-9_]/.test(text.slice(t.end, t.end + 1))) {
        out.push({ ...t, kind: "go" });
        if (count) k++;
        continue;
      }
    }
    out.push(t);
  }
  return out;
}

/** Tokens split into batches at `go` tokens; empty batches are dropped. */
export function batches(tokens: readonly Token[]): Token[][] {
  const out: Token[][] = [];
  let cur: Token[] = [];
  for (const t of tokens) {
    if (t.kind === "go") {
      if (cur.length > 0) out.push(cur);
      cur = [];
    } else cur.push(t);
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

export const upper = (t: Token | undefined): string => (t && t.kind === "word" ? t.value.toUpperCase() : "");

/** The source text of a run of tokens, from the first token's start to the last token's end. */
export function sourceOf(text: string, tokens: readonly Token[]): string {
  if (tokens.length === 0) return "";
  return text.slice(tokens[0]!.start, tokens[tokens.length - 1]!.end);
}
