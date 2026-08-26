/**
 * Lightweight TOML parser (#446).
 *
 * Written for the audit engine's spike: is there a pure, dependency-free way
 * to parse a config format the engine can't read today? TOML fits — it is a
 * fully-specified, static (no macros/interpolation/imports) grammar, so a
 * hand-rolled tokenizer + recursive-descent parser covers it without any
 * runtime surface a Workers sandbox would reject (no `eval`, no native
 * modules, no filesystem/network).
 *
 * Covers the subset of TOML v1.0 that real-world deploy configs
 * (`wrangler.toml`, `Cargo.toml`, `pyproject.toml`, `netlify.toml`) actually
 * use: basic/literal strings (single-line), integers, floats, booleans,
 * arrays (including multi-line), inline tables, dotted keys, standard tables
 * (`[a.b]`), and arrays of tables (`[[a.b]]`).
 *
 * Deliberately NOT a full spec implementation:
 *  - Multi-line strings (`"""..."""`, `'''...'''`) are read as a single
 *    opaque string body (no line-ending backslash trimming); good enough to
 *    not crash, not spec-perfect for continuation whitespace.
 *  - Dates/times are returned as their raw source text (a string), not a
 *    `Date` — none of the checks built on this parser need calendar math.
 *  - A dotted-key path element must be a bare word or a plain quoted string;
 *    mixing exotic key shapes mid-path is not supported.
 * These gaps only matter for exotic TOML; they don't affect the shapes the
 * audit checks read (`[vars]`, `[[kv_namespaces]]`, `[env.NAME]`, …).
 */

export class TomlParseError extends Error {}

type Token =
  | { t: "["; }
  | { t: "]"; }
  | { t: "[["; }
  | { t: "]]"; }
  | { t: "{"; }
  | { t: "}"; }
  | { t: "="; }
  | { t: ","; }
  | { t: "."; }
  | { t: "nl"; }
  | { t: "str"; v: string; }
  | { t: "bare"; v: string; }
  | { t: "eof"; };

const STOP_CHARS = new Set([" ", "\t", "\r", "\n", "[", "]", "{", "}", "=", ",", ".", "#", '"', "'"]);
/** Same stop set, minus `.` — used for numeric-looking tokens so `3.14` lexes whole. */
const NUM_STOP_CHARS = new Set([...STOP_CHARS].filter((ch) => ch !== "."));

/** Read a quoted string (basic `"..."`/`'...'` or multi-line `"""..."""`/`'''...'''`) starting at `i` (the opening quote). */
function readString(s: string, i: number): { value: string; next: number } {
  const q = s[i];
  const literal = q === "'";
  const triple = s[i + 1] === q && s[i + 2] === q;
  const quoteLen = triple ? 3 : 1;
  let j = i + quoteLen;
  // A newline immediately after an opening multi-line delimiter is trimmed (TOML spec).
  if (triple && s[j] === "\r") j++;
  if (triple && s[j] === "\n") j++;
  let out = "";
  while (true) {
    if (j >= s.length) throw new TomlParseError(`Unterminated string starting at offset ${i}`);
    if (s.startsWith(q.repeat(quoteLen), j)) {
      return { value: out, next: j + quoteLen };
    }
    const c = s[j];
    if (!triple && (c === "\n" || c === "\r")) {
      throw new TomlParseError(`Unterminated single-line string starting at offset ${i}`);
    }
    if (literal) {
      out += c;
      j++;
      continue;
    }
    if (c === "\\") {
      const esc = s[j + 1];
      if (triple && (esc === "\n" || esc === "\r" || esc === " " || esc === "\t")) {
        // Line-ending backslash: consume the backslash, trailing whitespace, the
        // newline, and all leading whitespace on the next line (folds away).
        let k = j + 1;
        while (s[k] === " " || s[k] === "\t") k++;
        if (s[k] === "\r") k++;
        if (s[k] === "\n") k++;
        while (s[k] === " " || s[k] === "\t" || s[k] === "\n" || s[k] === "\r") k++;
        j = k;
        continue;
      }
      const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\" };
      if (esc !== undefined && esc in simple) {
        out += simple[esc];
        j += 2;
        continue;
      }
      if (esc === "u" || esc === "U") {
        const width = esc === "u" ? 4 : 8;
        const hex = s.slice(j + 2, j + 2 + width);
        if (hex.length < width || !/^[0-9a-fA-F]+$/.test(hex)) {
          throw new TomlParseError(`Invalid unicode escape at offset ${j}`);
        }
        out += String.fromCodePoint(parseInt(hex, 16));
        j += 2 + width;
        continue;
      }
      throw new TomlParseError(`Invalid escape \\${esc} at offset ${j}`);
    }
    out += c;
    j++;
  }
}

function lex(input: string): Token[] {
  const s = input.replace(/\r\n/g, "\n");
  const tokens: Token[] = [];
  let i = 0;
  let atLineStart = true;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === "\n") {
      tokens.push({ t: "nl" });
      i++;
      atLineStart = true;
      continue;
    }
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (c === "#") {
      while (i < n && s[i] !== "\n") i++;
      continue;
    }
    if (c === "[") {
      if (atLineStart && s[i + 1] === "[") {
        tokens.push({ t: "[[" });
        i += 2;
      } else {
        tokens.push({ t: "[" });
        i += 1;
      }
      atLineStart = false;
      continue;
    }
    if (c === "]") {
      if (s[i + 1] === "]" && tokens.length > 0 && hasUnmatchedArrayTableOpen(tokens)) {
        tokens.push({ t: "]]" });
        i += 2;
      } else {
        tokens.push({ t: "]" });
        i += 1;
      }
      atLineStart = false;
      continue;
    }
    if (c === "{") { tokens.push({ t: "{" }); i++; atLineStart = false; continue; }
    if (c === "}") { tokens.push({ t: "}" }); i++; atLineStart = false; continue; }
    if (c === "=") { tokens.push({ t: "=" }); i++; atLineStart = false; continue; }
    if (c === ",") { tokens.push({ t: "," }); i++; atLineStart = false; continue; }
    if (c === ".") { tokens.push({ t: "." }); i++; atLineStart = false; continue; }
    if (c === '"' || c === "'") {
      const { value, next } = readString(s, i);
      tokens.push({ t: "str", v: value });
      i = next;
      atLineStart = false;
      continue;
    }
    // A dotted key (`a.b`) uses `.` as a segment separator, so a plain
    // bareword stops there. A value that looks numeric (starts with a digit,
    // or +/- followed by one) needs `.` to stay IN the token so floats
    // (`3.14`) and dates (`2024-01-01`, already dash-based) lex as one piece.
    const numericStart = /[0-9]/.test(c) || ((c === "+" || c === "-") && /[0-9]/.test(s[i + 1] ?? ""));
    const stopSet = numericStart ? NUM_STOP_CHARS : STOP_CHARS;
    let j = i;
    while (j < n && !stopSet.has(s[j])) j++;
    if (j === i) throw new TomlParseError(`Unexpected character ${JSON.stringify(c)} at offset ${i}`);
    tokens.push({ t: "bare", v: s.slice(i, j) });
    i = j;
    atLineStart = false;
  }
  tokens.push({ t: "eof" });
  return tokens;
}

/** Is the most recent unmatched `[[` in `tokens` still open (no `]]` seen since)? Used only to decide whether a trailing `]]` closes an array-of-tables header vs. two array closes. */
function hasUnmatchedArrayTableOpen(tokens: Token[]): boolean {
  let depth = 0;
  for (const tok of tokens) {
    if (tok.t === "[[") depth++;
    else if (tok.t === "]]") depth--;
  }
  return depth > 0;
}

type TomlValue = string | number | boolean | TomlValue[] | { [k: string]: TomlValue };
type TomlTable = { [k: string]: TomlValue };

class Cursor {
  constructor(private tokens: Token[], private pos = 0) {}
  peek(): Token { return this.tokens[this.pos]; }
  next(): Token { return this.tokens[this.pos++]; }
  skipNl(): void { while (this.peek().t === "nl") this.pos++; }
  expect<T extends Token["t"]>(t: T): Extract<Token, { t: T }> {
    const tok = this.next();
    if (tok.t !== t) throw new TomlParseError(`Expected ${t}, got ${tok.t}`);
    return tok as Extract<Token, { t: T }>;
  }
}

/** Read a dotted key path (`a.b.c`) — bare words or quoted strings joined by `.`. */
function readPath(c: Cursor): string[] {
  const parts: string[] = [];
  while (true) {
    const tok = c.next();
    if (tok.t === "bare") parts.push(tok.v);
    else if (tok.t === "str") parts.push(tok.v);
    else throw new TomlParseError(`Expected a key segment, got ${tok.t}`);
    if (c.peek().t === ".") { c.next(); continue; }
    break;
  }
  return parts;
}

const INT_RE = /^[+-]?(0|[1-9](_?\d)*)$/;
const HEX_RE = /^0x[0-9A-Fa-f](_?[0-9A-Fa-f])*$/;
const OCT_RE = /^0o[0-7](_?[0-7])*$/;
const BIN_RE = /^0b[01](_?[01])*$/;
const FLOAT_RE = /^[+-]?(\d(_?\d)*)(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/;

/** Coerce a bare value token to boolean / number / raw string (dates fall through as strings). */
function coerceBare(raw: string): TomlValue {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "nan" || raw === "+nan" || raw === "-nan") return NaN;
  if (raw === "inf" || raw === "+inf") return Infinity;
  if (raw === "-inf") return -Infinity;
  if (HEX_RE.test(raw)) return parseInt(raw.replace(/_/g, ""), 16);
  if (OCT_RE.test(raw)) return parseInt(raw.replace(/_/g, "").slice(2), 8);
  if (BIN_RE.test(raw)) return parseInt(raw.replace(/_/g, "").slice(2), 2);
  if (INT_RE.test(raw)) return parseInt(raw.replace(/_/g, ""), 10);
  if (FLOAT_RE.test(raw) && /[.eE]/.test(raw)) return parseFloat(raw.replace(/_/g, ""));
  // Not a recognized scalar shape — likely a date/time or something exotic.
  // Kept as its raw source text rather than failing the whole document.
  return raw;
}

function parseValue(c: Cursor): TomlValue {
  const tok = c.peek();
  if (tok.t === "str") { c.next(); return tok.v; }
  if (tok.t === "bare") { c.next(); return coerceBare(tok.v); }
  if (tok.t === "[") return parseArray(c);
  if (tok.t === "{") return parseInlineTable(c);
  throw new TomlParseError(`Unexpected token ${tok.t} where a value was expected`);
}

function parseArray(c: Cursor): TomlValue[] {
  c.expect("[");
  const out: TomlValue[] = [];
  c.skipNl();
  while (c.peek().t !== "]") {
    out.push(parseValue(c));
    c.skipNl();
    if (c.peek().t === ",") { c.next(); c.skipNl(); continue; }
    break;
  }
  c.skipNl();
  c.expect("]");
  return out;
}

function assignDotted(target: TomlTable, path: string[], value: TomlValue): void {
  let cur: TomlTable = target;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    const existing = cur[seg];
    if (existing && typeof existing === "object" && !Array.isArray(existing)) {
      cur = existing as TomlTable;
    } else {
      const created: TomlTable = {};
      cur[seg] = created;
      cur = created;
    }
  }
  cur[path[path.length - 1]] = value;
}

function parseInlineTable(c: Cursor): TomlTable {
  c.expect("{");
  const out: TomlTable = {};
  // Inline tables are single-line per spec, but stray newlines are tolerated
  // here rather than rejected — the audit must never crash on odd input.
  c.skipNl();
  while (c.peek().t !== "}") {
    const path = readPath(c);
    c.expect("=");
    const value = parseValue(c);
    assignDotted(out, path, value);
    c.skipNl();
    if (c.peek().t === ",") { c.next(); c.skipNl(); continue; }
    break;
  }
  c.skipNl();
  c.expect("}");
  return out;
}

/** Navigate/create a nested table (or the last element of a nested array-of-tables) at `path`, per TOML header semantics. */
function navigateTable(root: TomlTable, path: string[]): TomlTable {
  let cur: TomlTable = root;
  for (const seg of path) {
    const existing = cur[seg];
    if (existing === undefined) {
      const created: TomlTable = {};
      cur[seg] = created;
      cur = created;
    } else if (Array.isArray(existing)) {
      const last = existing[existing.length - 1];
      if (!last || typeof last !== "object") throw new TomlParseError(`Cannot navigate into array segment "${seg}"`);
      cur = last as TomlTable;
    } else if (typeof existing === "object") {
      cur = existing as TomlTable;
    } else {
      throw new TomlParseError(`Key "${seg}" is already a scalar value`);
    }
  }
  return cur;
}

function navigateArrayTable(root: TomlTable, path: string[]): TomlTable {
  const parent = navigateTable(root, path.slice(0, -1));
  const last = path[path.length - 1];
  const existing = parent[last];
  const arr: TomlValue[] = Array.isArray(existing) ? existing : [];
  if (!Array.isArray(existing)) parent[last] = arr;
  const entry: TomlTable = {};
  arr.push(entry);
  return entry;
}

/**
 * Parse a TOML document into a plain nested object. Throws {@link TomlParseError}
 * on malformed input — callers that scan arbitrary repo files should wrap the
 * call in a try/catch (matching the rest of the audit engine's tolerance for
 * unparseable content).
 */
export function parseTOML(input: string): TomlTable {
  const tokens = lex(input);
  const c = new Cursor(tokens);
  const root: TomlTable = {};
  let current: TomlTable = root;
  c.skipNl();
  while (c.peek().t !== "eof") {
    const tok = c.peek();
    if (tok.t === "[") {
      c.next();
      const path = readPath(c);
      c.expect("]");
      current = navigateTable(root, path);
    } else if (tok.t === "[[") {
      c.next();
      const path = readPath(c);
      c.expect("]]");
      current = navigateArrayTable(root, path);
    } else {
      const path = readPath(c);
      c.expect("=");
      const value = parseValue(c);
      assignDotted(current, path, value);
    }
    const end = c.next();
    if (end.t === "eof") break;
    if (end.t !== "nl") throw new TomlParseError(`Expected end of line, got ${end.t}`);
    c.skipNl();
  }
  return root;
}
