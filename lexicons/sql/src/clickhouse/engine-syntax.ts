/**
 * Read the argument list out of a ClickHouse engine's one-line `syntax`
 * (`system.table_engines.syntax`, `system.data_skipping_index_types.syntax`).
 *
 * The line is prose, not grammar: `ReplacingMergeTree([ver [, is_deleted]])`,
 * `Join(join_strictness, join_type, k1[, k2, ...])`,
 * `File(format[, path | fd])`. What it does give reliably is each argument's
 * name, position, whether it sits inside brackets (optional), whether it is a
 * quoted placeholder (a string literal), and a trailing `...` (repeatable).
 * That is the generated half of an engine's argument types; what kind of value
 * each argument takes is the overlay's half (`overlays/engines.ts`).
 *
 * A line this reader cannot follow yields `undefined`, never a guess, and the
 * engine's arguments stay untyped.
 */

export interface SyntaxArgument {
  /** The placeholder's name. Alternatives are joined with `|`: `path|fd`. A quoted placeholder keeps its text: `host:port`. */
  name: string;
  /** 0-based position among the arguments. */
  position: number;
  /** Inside `[...]` in the syntax line. */
  optional: boolean;
  /** Written as a quoted placeholder, so the argument is a string literal. */
  quoted: boolean;
  /** Followed by `...`: the argument repeats. */
  repeated: boolean;
  /** Written `name = value`: a named parameter, not a positional one (`text(tokenizer = ...)`). */
  named: boolean;
}

export interface ParsedSyntax {
  /** The engine or index type name the line opens with. */
  name: string;
  /** False when the line has no parenthesised list at all (`ENGINE = Log`). */
  parenthesised: boolean;
  args: SyntaxArgument[];
}

type Token =
  | { t: "name"; v: string }
  | { t: "quoted"; v: string }
  | { t: "[" | "]" | "," | "|" | "..." | "=" };

function tokenize(text: string): Token[] | undefined {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "[" || c === "]" || c === "," || c === "|" || c === "=") {
      out.push({ t: c });
      i++;
    } else if (text.startsWith("...", i)) {
      out.push({ t: "..." });
      i += 3;
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return undefined;
      out.push({ t: "quoted", v: text.slice(i + 1, end) });
      i = end + 1;
    } else {
      const m = /^[A-Za-z_][\w.]*/.exec(text.slice(i));
      if (!m) return undefined;
      out.push({ t: "name", v: m[0] });
      i += m[0].length;
    }
  }
  return out;
}

/** The text between the first `(` after the name and its matching `)`. */
function argumentText(rest: string): string | undefined {
  if (!rest.startsWith("(")) return undefined;
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "(") depth++;
    else if (rest[i] === ")") {
      depth--;
      if (depth === 0) return rest.slice(1, i);
    }
  }
  return undefined;
}

/**
 * Parse `ENGINE = Name(args) ...` or `INDEX name expr TYPE Name(args) ...`.
 * Returns `undefined` for a line that is not one of those shapes or whose
 * argument list does not follow the bracket-and-comma convention.
 */
export function parseEngineSyntax(syntax: string): ParsedSyntax | undefined {
  const head = /^(?:ENGINE\s*=\s*|INDEX\s+\S+\s+\S+\s+TYPE\s+)([A-Za-z_]\w*)/.exec(syntax.trim());
  if (!head) return undefined;
  const name = head[1]!;
  const rest = syntax.trim().slice(head[0].length);
  if (!rest.startsWith("(")) return { name, parenthesised: false, args: [] };
  const inner = argumentText(rest);
  if (inner === undefined) return undefined;
  const tokens = tokenize(inner);
  if (!tokens) return undefined;

  const args: SyntaxArgument[] = [];
  let depth = 0;
  let pending: { names: string[]; quoted: boolean; optional: boolean; named: boolean } | undefined;
  let afterBar = false;
  let afterEquals = false;

  const flush = () => {
    if (!pending) return;
    args.push({
      name: pending.names.join("|"),
      position: args.length,
      optional: pending.optional,
      quoted: pending.quoted,
      repeated: false,
      named: pending.named,
    });
    pending = undefined;
  };

  for (const tok of tokens) {
    switch (tok.t) {
      case "[":
        depth++;
        break;
      case "]":
        if (depth === 0) return undefined;
        depth--;
        break;
      case ",":
        flush();
        afterBar = false;
        afterEquals = false;
        break;
      case "|":
        if (!pending) return undefined;
        afterBar = true;
        break;
      case "...":
        // `input_query...` repeats the argument it follows; `k2, ...` repeats the last one.
        flush();
        if (args.length === 0) return undefined;
        args[args.length - 1]!.repeated = true;
        break;
      case "=":
        // `key = value, ...` is a settings tail (BigQuery); `tokenizer = x` names a parameter (text index).
        if (!pending || pending.names.length !== 1) return undefined;
        pending.named = true;
        afterEquals = true;
        break;
      case "name":
      case "quoted": {
        if (pending && afterEquals) {
          // The value placeholder after `=` is an example, not a second argument.
          afterEquals = false;
          break;
        }
        if (pending && afterBar) {
          pending.names.push(tok.v);
          afterBar = false;
          break;
        }
        if (pending) return undefined;
        pending = { names: [tok.v], quoted: tok.t === "quoted", optional: depth > 0, named: false };
        break;
      }
    }
  }
  flush();
  if (depth !== 0) return undefined;
  return { name, parenthesised: true, args };
}
