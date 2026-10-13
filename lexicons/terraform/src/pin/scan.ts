/**
 * Byte offsets for the attribute values the pin edit rewrites (#3189).
 *
 * `@cdktn/hcl2json` is the reader that says what a file means, and the pin
 * edit asks it first (`./edit.ts`). It gives back values and no positions
 * (`../hcl/value.ts` says why), so it cannot say WHERE in the file a
 * `source` or `version` literal sits. This lexer answers only that: it walks
 * the raw text token by token, skipping comments, quoted strings, template
 * interpolations and heredocs, counts braces, and records each top-level
 * block and the plain string literal of each of its own attributes, with the
 * literal's offsets.
 *
 * It is an HCL tokenizer, not a pattern match over lines: a `source =` inside
 * a comment, a heredoc or another string is never a match, and a block opened
 * on the same line as its attributes reads the same as one split over lines.
 * What it finds is checked against the reader before anything is written:
 * the literal's unescaped value has to equal what hcl2json read for that
 * attribute, and the edited file has to parse to the same tree with only the
 * pinned values changed.
 */

/** One plain string literal: the offsets of its content, quotes excluded. */
export interface ScannedLiteral {
  start: number;
  end: number;
  /** The content as written, escapes included. */
  raw: string;
}

/** One attribute of a block body. `literal` is set when the value is a single string with no interpolation. */
export interface ScannedAttribute {
  name: string;
  literal?: ScannedLiteral;
}

/** One top-level block: `module "vpc" { ... }`, `terraform { ... }`. */
export interface ScannedBlock {
  type: string;
  labels: string[];
  /** Offset of the block's type keyword. */
  start: number;
  /** Offset just past the closing brace. */
  end: number;
  /** The block body's own attributes, in file order. Nested blocks' attributes are not included. */
  attributes: ScannedAttribute[];
}

type Token =
  | { kind: "ident"; value: string; start: number; end: number }
  | { kind: "string"; start: number; end: number; raw: string; template: boolean }
  | { kind: "punct"; value: string; start: number; end: number }
  | { kind: "newline"; start: number; end: number }
  | { kind: "other"; start: number; end: number };

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_-]/;

/** Thrown when the text is not well-formed enough to place an edit in. */
export class HclScanError extends Error {
  constructor(file: string, message: string) {
    super(`${file}: ${message}`);
    this.name = "HclScanError";
  }
}

/**
 * Skip a quoted string starting at `i` (the opening quote). Returns the index
 * just past the closing quote, and whether a `${` or `%{` template appears.
 */
function skipString(text: string, i: number, file: string): { end: number; template: boolean } {
  let j = i + 1;
  let template = false;
  while (j < text.length) {
    const c = text[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === '"') return { end: j + 1, template };
    if (c === "\n") throw new HclScanError(file, `unterminated string at offset ${i}`);
    if ((c === "$" || c === "%") && text[j + 1] === "{") {
      // `$${` and `%%{` are escapes for a literal `${` and `%{`.
      if (text[j - 1] === c) {
        j += 2;
        continue;
      }
      template = true;
      j = skipTemplate(text, j + 2, file);
      continue;
    }
    j++;
  }
  throw new HclScanError(file, `unterminated string at offset ${i}`);
}

/** Skip a template interpolation body starting just inside `${`. Returns the index past its `}`. */
function skipTemplate(text: string, i: number, file: string): number {
  let depth = 1;
  let j = i;
  while (j < text.length) {
    const c = text[j];
    if (c === '"') {
      j = skipString(text, j, file).end;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  throw new HclScanError(file, `unterminated template at offset ${i}`);
}

function tokenize(text: string, file: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\n") {
      tokens.push({ kind: "newline", start: i, end: i + 1 });
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "#" || (c === "/" && text[i + 1] === "/")) {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close < 0) throw new HclScanError(file, `unterminated comment at offset ${i}`);
      // A block comment spanning lines still ends a statement where a newline would.
      if (text.slice(i, close).includes("\n")) tokens.push({ kind: "newline", start: i, end: close + 2 });
      i = close + 2;
      continue;
    }
    if (c === '"') {
      const { end, template } = skipString(text, i, file);
      tokens.push({ kind: "string", start: i, end, raw: text.slice(i + 1, end - 1), template });
      i = end;
      continue;
    }
    if (c === "<" && text[i + 1] === "<" && /[-A-Za-z_]/.test(text[i + 2] ?? "")) {
      const m = /^<<-?([A-Za-z_][A-Za-z0-9_-]*)[ \t]*\r?\n/.exec(text.slice(i));
      if (m) {
        const marker = m[1]!;
        let j = i + m[0].length;
        for (;;) {
          const lineEnd = text.indexOf("\n", j);
          const line = text.slice(j, lineEnd < 0 ? text.length : lineEnd);
          if (line.trim() === marker) {
            j = lineEnd < 0 ? text.length : lineEnd;
            break;
          }
          if (lineEnd < 0) throw new HclScanError(file, `unterminated heredoc ${marker} at offset ${i}`);
          j = lineEnd + 1;
        }
        tokens.push({ kind: "other", start: i, end: j });
        i = j;
        continue;
      }
    }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < text.length && IDENT_PART.test(text[j]!)) j++;
      tokens.push({ kind: "ident", value: text.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (two === "==" || two === "!=" || two === "<=" || two === ">=" || two === "=>" || two === "&&" || two === "||") {
      tokens.push({ kind: "punct", value: two, start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if ("{}[]()=,.:?".includes(c)) {
      tokens.push({ kind: "punct", value: c, start: i, end: i + 1 });
      i++;
      continue;
    }
    tokens.push({ kind: "other", start: i, end: i + 1 });
    i++;
  }
  return tokens;
}

const OPEN = new Set(["{", "[", "("]);
const CLOSE = new Set(["}", "]", ")"]);

/** Every top-level block in `text`, with its own attributes' literals. */
export function scanBlocks(text: string, file: string): ScannedBlock[] {
  const tokens = tokenize(text, file);
  const blocks: ScannedBlock[] = [];
  let i = 0;
  const atStatementStart = (k: number) => k === 0 || tokens[k - 1]!.kind === "newline" || (tokens[k - 1]!.kind === "punct" && (tokens[k - 1] as { value: string }).value === "{");

  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t.kind !== "ident" || !atStatementStart(i)) {
      i = skipStatement(tokens, i);
      continue;
    }
    // A block header: a type, then string or identifier labels, then `{`.
    const labels: string[] = [];
    let j = i + 1;
    while (j < tokens.length) {
      const l = tokens[j]!;
      if (l.kind === "string" && !l.template) labels.push(l.raw);
      else if (l.kind === "ident") labels.push(l.value);
      else break;
      j++;
    }
    const brace = tokens[j];
    if (!brace || brace.kind !== "punct" || brace.value !== "{") {
      i = skipStatement(tokens, i);
      continue;
    }
    const { end, attributes } = readBody(tokens, j, file);
    blocks.push({ type: t.value, labels, start: t.start, end: tokens[end]!.end, attributes });
    i = end + 1;
  }
  return blocks;
}

/** Skip to the token after the end of the statement starting at `i`: the next newline at bracket depth 0. */
function skipStatement(tokens: Token[], i: number): number {
  let depth = 0;
  let j = i;
  while (j < tokens.length) {
    const t = tokens[j]!;
    if (t.kind === "punct" && OPEN.has(t.value)) depth++;
    else if (t.kind === "punct" && CLOSE.has(t.value)) depth = Math.max(0, depth - 1);
    else if (t.kind === "newline" && depth === 0) return j + 1;
    j++;
  }
  return j;
}

/** Read a block body whose `{` is at `open`. Returns the index of the matching `}` and the body's own attributes. */
function readBody(tokens: Token[], open: number, file: string): { end: number; attributes: ScannedAttribute[] } {
  const attributes: ScannedAttribute[] = [];
  let depth = 1;
  let j = open + 1;
  let statementStart = true;
  while (j < tokens.length) {
    const t = tokens[j]!;
    if (t.kind === "newline") {
      if (depth === 1) statementStart = true;
      j++;
      continue;
    }
    if (depth === 1 && statementStart && t.kind === "ident") {
      const eq = tokens[j + 1];
      if (eq && eq.kind === "punct" && eq.value === "=") {
        const value = tokens[j + 2];
        const after = tokens[j + 3];
        const ends = !after || after.kind === "newline" || (after.kind === "punct" && after.value === "}");
        const literal = value && value.kind === "string" && !value.template && ends ? { start: value.start + 1, end: value.end - 1, raw: value.raw } : undefined;
        attributes.push({ name: t.value, ...(literal ? { literal } : {}) });
      }
    }
    statementStart = false;
    if (t.kind === "punct" && OPEN.has(t.value)) depth++;
    else if (t.kind === "punct" && CLOSE.has(t.value)) {
      depth--;
      if (depth === 0) return { end: j, attributes };
    }
    j++;
  }
  throw new HclScanError(file, `unbalanced braces: a block opened at offset ${tokens[open]!.start} never closes`);
}

/** Undo HCL's string escapes, so a literal's raw text compares to the value the reader returned. */
export function unescapeHcl(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === "\\") {
      const n = raw[i + 1];
      i++;
      if (n === "n") out += "\n";
      else if (n === "t") out += "\t";
      else if (n === "r") out += "\r";
      else if (n === "u" || n === "U") {
        const len = n === "u" ? 4 : 8;
        out += String.fromCodePoint(parseInt(raw.slice(i + 1, i + 1 + len), 16));
        i += len;
      } else out += n ?? "";
      continue;
    }
    if ((c === "$" || c === "%") && raw[i + 1] === c && raw[i + 2] === "{") {
      out += `${c}{`;
      i += 2;
      continue;
    }
    out += c;
  }
  return out;
}

/** Write a value as the content of an HCL string literal. */
export function escapeHcl(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\$\{/g, "$${").replace(/%\{/g, "%%{");
}
