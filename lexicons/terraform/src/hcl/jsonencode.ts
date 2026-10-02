/**
 * Read the argument of a `jsonencode(...)` call as structure, when it is
 * literal (chant #2286, shared with #2287).
 *
 * hcl2json does not evaluate expressions. `policy = jsonencode({...})` and
 * `container_definitions = jsonencode([...])` both reach a block body as ONE
 * string holding the expression's source text, wrapped as an interpolation:
 *
 * ```
 * "${jsonencode({\n    Version = \"2012-10-17\"\n    Statement = [{ Action = \"*\" }]\n  })}"
 * ```
 *
 * The text inside is HCL object syntax, not JSON (`=` or `:` separators, bare
 * keys, newline-separated items, `#` comments). A rule that wants the policy
 * or the container definitions has to read that text itself. This file does
 * so, narrowly: it accepts literal objects, tuples, quoted strings, numbers,
 * `true`, `false` and `null`, and nothing else. Any expression in the
 * argument (a reference, a function call, a for-expression, a splat, a
 * conditional, an operator, a template interpolation inside a string, a
 * heredoc, a parenthesised key) makes the whole read `not-determined`, with a
 * reason naming what was found. It never evaluates anything, so it can never
 * return a value Terraform would not also produce from the same text.
 *
 * Three answers:
 * - `literal`: the value is a single whole-string `${jsonencode(...)}` and
 *   its argument is fully literal. `value` is the plain JS value
 *   `jsonencode` would encode.
 * - `not-determined`: the value is a `${jsonencode(...)}` call, but the
 *   argument holds something this reader does not evaluate.
 * - `not-jsonencode`: the value is not a `${jsonencode(...)}` call at all
 *   (a plain string, a reference, `file(...)`, a number, absent). Callers
 *   decide what that means for their attribute; a plain string, for example,
 *   may itself be JSON from a heredoc.
 *
 * The whole-string test is shape-based: the string starts `${jsonencode(` and
 * ends `)}`. A string that matches that shape but is really a template with
 * two interpolations (`${jsonencode(a)}-${jsonencode(b)}`) fails the literal
 * parse at the point where the first call closes early, and reads as
 * `not-determined`, never as `literal`.
 */

export type JsonencodeRead =
  /** The argument is a fully literal HCL object/tuple/string/number/bool/null tree. */
  | { kind: "literal"; value: unknown }
  /** `jsonencode(...)` whose argument contains a reference, function call, for-expression, splat, conditional, etc. */
  | { kind: "not-determined"; reason: string }
  /** The value is not a single whole-string `${jsonencode(...)}` at all. */
  | { kind: "not-jsonencode" };

export interface ReadJsonencodeOptions {
  /**
   * Read past a non-literal VALUE instead of giving up on the whole argument.
   * Each such value (a reference, a function call, a conditional, an
   * interpolated string, a heredoc, any other expression) becomes an
   * {@link UnknownLeaf} in the returned tree, so a rule can still read the
   * literal fields beside it: `Action = "*"` next to
   * `Resource = aws_s3_bucket.x.arn`, or a container's literal `environment`
   * next to `image = var.image`.
   *
   * The skip is narrow. It consumes one value expression, balancing `()[]{}`
   * and quoted strings, up to the next `,`, newline or closing bracket at its
   * own depth. A member whose KEY is an expression (an interpolated quoted
   * key or a parenthesised computed key) is dropped from its object and listed
   * under {@link UNKNOWN_KEYS} on that object. Damage to the STRUCTURE is
   * still `not-determined`: a for-expression producing a collection, or an
   * expression as the whole argument (`jsonencode(local.policy)`,
   * `jsonencode(var.x[*])`), since then no key or element is known.
   */
  unknownLeaves?: boolean;
}

/** Marks a value position `readJsonencode(raw, { unknownLeaves: true })` could not read. */
export const UNKNOWN: unique symbol = Symbol("jsonencode.unknown");

/** A value position holding an expression; `reason` names what was found there. */
export interface UnknownLeaf {
  readonly [UNKNOWN]: true;
  readonly reason: string;
}

/**
 * Marks an object, read with `unknownLeaves`, that had members whose KEY is an
 * expression (`"router-${var.n}.rule" = ...`, `(var.k) = ...`). Those members
 * are dropped from the object and their reasons listed here, so a reader can
 * tell "this key is absent" from "some key here could not be read".
 */
export const UNKNOWN_KEYS: unique symbol = Symbol("jsonencode.unknownKeys");

/** Whether `obj` is an object that dropped one or more members with an expression key. */
export function hasUnknownKeys(obj: unknown): obj is Record<string, unknown> & { [UNKNOWN_KEYS]: string[] } {
  return (
    typeof obj === "object" &&
    obj !== null &&
    Array.isArray((obj as Record<symbol, unknown>)[UNKNOWN_KEYS]) &&
    ((obj as Record<symbol, unknown>)[UNKNOWN_KEYS] as unknown[]).length > 0
  );
}

/** Whether `v` is a value position the reader skipped. */
export function isUnknown(v: unknown): v is UnknownLeaf {
  return typeof v === "object" && v !== null && (v as Record<symbol, unknown>)[UNKNOWN] === true;
}

const PREFIX = /^\$\{\s*jsonencode\s*\(/;
const SUFFIX = /\)\s*\}$/;

/** Read `raw` (an hcl2json attribute value) as a `jsonencode(...)` call. */
export function readJsonencode(raw: unknown, options: ReadJsonencodeOptions = {}): JsonencodeRead {
  if (typeof raw !== "string") return { kind: "not-jsonencode" };
  const prefix = PREFIX.exec(raw);
  if (!prefix || !SUFFIX.test(raw)) return { kind: "not-jsonencode" };

  const reader = new Reader(raw, prefix[0].length, options.unknownLeaves === true);
  try {
    const value = reader.value(0);
    reader.skipSpace();
    // The argument must end at the call's own `)`, then the interpolation's `}`.
    reader.expect(")", "a second argument or an expression after the literal");
    reader.skipSpace();
    reader.expect("}", "text after the jsonencode call");
    if (!reader.atEnd()) throw new NotLiteral("text after the jsonencode call");
    return { kind: "literal", value };
  } catch (err) {
    if (err instanceof NotLiteral) return { kind: "not-determined", reason: err.message };
    throw err;
  }
}

class NotLiteral extends Error {}

/** Damage to the shape itself: never recovered by skipping a leaf. */
class Structural extends NotLiteral {}

/** An object key that is an expression; recoverable by dropping the member under `unknownLeaves`. */
class KeyNotLiteral extends Structural {}

const IDENT = /[A-Za-z_][A-Za-z0-9_-]*/y;
const NUMBER = /-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

/** A cursor over the source text of the jsonencode argument. */
class Reader {
  constructor(
    private readonly src: string,
    private pos: number,
    private readonly unknownLeaves = false,
  ) {}

  atEnd(): boolean {
    return this.pos >= this.src.length;
  }

  private peek(): string {
    return this.src[this.pos] ?? "";
  }

  expect(ch: string, what: string): void {
    if (this.peek() !== ch) throw new NotLiteral(what === "" ? `expected "${ch}"` : what);
    this.pos++;
  }

  /** Whitespace, newlines and the three HCL comment forms. */
  skipSpace(newlines = true): void {
    for (;;) {
      const c = this.peek();
      if (c === " " || c === "\t" || c === "\r" || (newlines && c === "\n")) {
        this.pos++;
      } else if (c === "#" || (c === "/" && this.src[this.pos + 1] === "/")) {
        const end = this.src.indexOf("\n", this.pos);
        this.pos = end === -1 ? this.src.length : end;
      } else if (c === "/" && this.src[this.pos + 1] === "*") {
        const end = this.src.indexOf("*/", this.pos + 2);
        if (end === -1) throw new NotLiteral("an unterminated comment");
        this.pos = end + 2;
      } else {
        return;
      }
    }
  }

  /** One value. `depth` is 0 for the whole argument, which is never skipped. */
  value(depth: number): unknown {
    this.skipSpace();
    if (!this.unknownLeaves || depth === 0) return this.literal(depth);
    const start = this.pos;
    try {
      return this.literal(depth);
    } catch (err) {
      if (!(err instanceof NotLiteral) || err instanceof Structural) throw err;
      this.pos = start;
      this.skipExpression();
      return { [UNKNOWN]: true, reason: err.message } satisfies UnknownLeaf;
    }
  }

  private literal(depth: number): unknown {
    const c = this.peek();
    let v: unknown;
    if (c === "{") v = this.object(depth + 1);
    else if (c === "[") v = this.tuple(depth + 1);
    else if (c === '"') v = this.string();
    else if (c === "<" && this.src.startsWith("<<", this.pos)) throw new NotLiteral("a heredoc");
    else if (c === "(") throw new NotLiteral("a parenthesised expression");
    else if (c === "-" || (c >= "0" && c <= "9")) v = this.number();
    else v = this.keyword();
    this.afterValue();
    return v;
  }

  /**
   * A literal is complete only if what follows it closes or separates. An
   * operator, a conditional, an attribute access or an index after it makes
   * the whole thing an expression.
   */
  private afterValue(): void {
    this.skipSpace(false);
    const c = this.peek();
    if (c === "" || c === "\n" || c === "," || c === "}" || c === "]" || c === ")") return;
    const next = this.src[this.pos + 1];
    if (c === "#" || (c === "/" && (next === "/" || next === "*"))) return; // a comment, consumed by the caller's skipSpace
    if (c === "?") throw new NotLiteral("a conditional expression");
    if (c === "." || c === "[") throw new NotLiteral("an attribute access, index or splat");
    throw new NotLiteral(`an operator or expression ("${c}")`);
  }

  private object(depth: number): Record<string, unknown> {
    this.expect("{", "");
    const out: Record<string, unknown> = {};
    for (;;) {
      this.skipSpace();
      if (this.peek() === "}") {
        this.pos++;
        return out;
      }
      const quoted = this.peek() === '"';
      const memberStart = this.pos;
      let key: string;
      try {
        key = this.key();
      } catch (err) {
        if (!(err instanceof KeyNotLiteral) || !this.unknownLeaves) throw err;
        // Drop the whole member: the skip runs from the key through its value
        // to the separator, balancing brackets and quotes on the way.
        this.pos = memberStart;
        this.skipExpression();
        const bag = out as Record<symbol, string[]>;
        (bag[UNKNOWN_KEYS] ??= []).push(err.message);
        this.skipSpace(false);
        if (this.peek() === ",") this.pos++;
        continue;
      }
      this.skipSpace(false);
      const sep = this.peek();
      if (sep !== "=" && sep !== ":") {
        if (!quoted && key === "for") throw new Structural("a for-expression");
        throw new Structural(`an expression where "${key}" needs = or :`);
      }
      this.pos++;
      out[key] = this.value(depth);
      this.skipSpace(false);
      if (this.peek() === ",") this.pos++;
    }
  }

  private key(): string {
    const c = this.peek();
    if (c === '"') {
      try {
        return this.string();
      } catch (err) {
        if (err instanceof NotLiteral) throw new KeyNotLiteral(`an object key holding ${err.message.replace(/^a string with /, "")}`);
        throw err;
      }
    }
    if (c === "(") throw new KeyNotLiteral("a computed object key");
    IDENT.lastIndex = this.pos;
    const m = IDENT.exec(this.src);
    if (!m) throw new Structural(`an unexpected "${c}" where an object key belongs`);
    this.pos += m[0].length;
    return m[0];
  }

  private tuple(depth: number): unknown[] {
    this.expect("[", "");
    this.skipSpace();
    if (/^for\s/.test(this.src.slice(this.pos, this.pos + 4))) throw new Structural("a for-expression");
    const out: unknown[] = [];
    for (;;) {
      this.skipSpace();
      if (this.peek() === "]") {
        this.pos++;
        return out;
      }
      out.push(this.value(depth));
      this.skipSpace();
      if (this.peek() === ",") this.pos++;
      else if (this.peek() !== "]") throw new NotLiteral("a tuple item followed by an expression");
    }
  }

  /** A quoted HCL string. A `${` or `%{` (not escaped as `$${`/`%%{`) is a template. */
  private string(): string {
    this.expect('"', "");
    let out = "";
    for (;;) {
      const c = this.peek();
      if (c === "") throw new NotLiteral("an unterminated string");
      if (c === "\n") throw new NotLiteral("a newline inside a quoted string");
      if (c === '"') {
        this.pos++;
        return out;
      }
      if ((c === "$" || c === "%") && this.src[this.pos + 1] === c && this.src[this.pos + 2] === "{") {
        out += `${c}{`;
        this.pos += 3;
        continue;
      }
      if ((c === "$" || c === "%") && this.src[this.pos + 1] === "{") {
        throw new NotLiteral(c === "$" ? "a string with a ${...} interpolation" : "a string with a %{...} directive");
      }
      if (c === "\\") {
        out += this.escape();
        continue;
      }
      out += c;
      this.pos++;
    }
  }

  private escape(): string {
    const e = this.src[this.pos + 1] ?? "";
    this.pos += 2;
    switch (e) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "u":
      case "U": {
        const len = e === "u" ? 4 : 8;
        const hex = this.src.slice(this.pos, this.pos + len);
        if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== len) throw new NotLiteral("a malformed unicode escape");
        this.pos += len;
        return String.fromCodePoint(parseInt(hex, 16));
      }
      default:
        throw new NotLiteral(`an unknown string escape "\\${e}"`);
    }
  }

  private number(): number {
    NUMBER.lastIndex = this.pos;
    const m = NUMBER.exec(this.src);
    if (!m) throw new NotLiteral("a unary operator on an expression");
    this.pos += m[0].length;
    return Number(m[0]);
  }

  private keyword(): unknown {
    IDENT.lastIndex = this.pos;
    const m = IDENT.exec(this.src);
    if (!m) throw new NotLiteral(`an unexpected "${this.peek()}"`);
    const word = m[0];
    this.pos += word.length;
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    this.skipSpace(false);
    if (this.peek() === "(") throw new NotLiteral(`a function call (${word}(...))`);
    if (word === "for") throw new NotLiteral("a for-expression");
    return this.reference(word);
  }

  /**
   * Skip one value expression from the cursor: balance `()[]{}` and quoted
   * strings (with their `${...}` interpolations), stop at a `,`, a newline, a
   * comment or a closing bracket at depth 0. A heredoc is skipped to its
   * closing marker line.
   */
  private skipExpression(): void {
    let depth = 0;
    while (!this.atEnd()) {
      const c = this.peek();
      if (depth === 0) {
        if (c === "," || c === "\n" || c === "}" || c === "]" || c === ")" || c === "#") return;
        if (c === "/" && (this.src[this.pos + 1] === "/" || this.src[this.pos + 1] === "*")) return;
      }
      if (c === '"') this.skipQuoted();
      else if (c === "<" && this.src.startsWith("<<", this.pos)) this.skipHeredoc();
      else {
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") depth--;
        this.pos++;
      }
    }
  }

  /** Skip a quoted string, including any `${...}` interpolations (which may hold strings). */
  private skipQuoted(): void {
    this.pos++;
    while (!this.atEnd()) {
      const c = this.peek();
      if (c === "\\") this.pos += 2;
      else if (c === '"') {
        this.pos++;
        return;
      } else if ((c === "$" || c === "%") && this.src[this.pos + 1] === "{") {
        this.pos += 2;
        let depth = 1;
        while (!this.atEnd() && depth > 0) {
          const d = this.peek();
          if (d === '"') {
            this.skipQuoted();
            continue;
          }
          if (d === "{") depth++;
          else if (d === "}") depth--;
          this.pos++;
        }
      } else this.pos++;
    }
    throw new Structural("an unterminated string");
  }

  private skipHeredoc(): void {
    const head = /<<-?([A-Za-z_][A-Za-z0-9_-]*)[ \t]*\n/y;
    head.lastIndex = this.pos;
    const m = head.exec(this.src);
    if (!m) throw new Structural("a malformed heredoc");
    const close = new RegExp(`^[ \\t]*${m[1]}[ \\t]*$`, "m");
    const rest = this.src.slice(this.pos + m[0].length);
    const end = close.exec(rest);
    if (!end) throw new Structural("an unterminated heredoc");
    this.pos += m[0].length + end.index + end[0].length;
  }

  private reference(word: string): never {
    throw new NotLiteral(`a reference (${word}${this.peek() === "." ? "..." : ""})`);
  }
}
