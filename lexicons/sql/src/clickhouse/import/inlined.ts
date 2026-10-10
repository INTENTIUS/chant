/**
 * Finding a SQL user-defined function in what ClickHouse stored (#3745).
 *
 * ClickHouse does not keep a call to a SQL function in a view's query or a
 * column's DEFAULT: it writes the function's body in place of the call, with
 * the arguments substituted, and a nested call expanded the same way.
 * `CREATE FUNCTION tax AS x -> (x * 0.2)` used as `tax(amt)` reads back as
 * `amt * 0.2`. So an import can't look for the name; it looks for the body.
 *
 * Each function's body is expanded (a call to another function becomes that
 * function's body), its parameters become wildcards, and the result is
 * matched against the stored statement's tokens. Parentheses that only
 * group are dropped on both sides, since the server adds or leaves them by
 * precedence where the body lands. A wildcard matches one balanced
 * expression, and a parameter used twice must match the same text twice.
 *
 * A function whose body is just a parameter (`x -> x`) leaves nothing to
 * look for, so it is never found this way.
 */

import { isTrivia, tokenizeText, type Token } from "../tokens";
import { unquote } from "../parser";

/** One item of a pattern: a token's text, or the parameter at `arg`. */
type Item = { lit: string } | { arg: number };

/** A function's parameters and body, from `CREATE FUNCTION name AS (x, y) -> body`; undefined when it doesn't read that way. */
export function functionLambda(statement: string): { params: string[]; body: Token[] } | undefined {
  let tokens: Token[];
  try {
    tokens = tokenizeText(statement, 0).filter((t) => !isTrivia(t));
  } catch {
    return undefined;
  }
  const as = tokens.findIndex((t) => t.kind === "ident" && t.text.toUpperCase() === "AS");
  const arrow = tokens.findIndex((t, i) => i > as && t.kind === "op" && t.text === "->");
  if (as < 0 || arrow < 0) return undefined;
  const params = tokens
    .slice(as + 1, arrow)
    .filter((t) => t.kind === "ident" || t.kind === "qident")
    .map(nameOf);
  const body = tokens.slice(arrow + 1);
  while (body.length > 0 && body[body.length - 1]!.kind === "punct" && body[body.length - 1]!.text === ";") body.pop();
  return { params, body };
}

const nameOf = (t: Token): string => (t.kind === "qident" ? unquote(t.text) : t.text);
const isPunct = (t: Token | undefined, text: string): boolean => t?.kind === "punct" && t.text === text;
const isName = (t: Token | undefined): boolean => t?.kind === "ident" || t?.kind === "qident";

/** Words a `(` can follow that make it a grouping, not a call. */
const GROUPING_AFTER = new Set(
  ["AND", "OR", "NOT", "IS", "LIKE", "ILIKE", "BETWEEN", "WHEN", "THEN", "ELSE", "CASE", "SELECT", "WHERE", "PREWHERE", "HAVING", "FROM", "ON", "AS", "BY", "DEFAULT", "MATERIALIZED", "ALIAS", "EPHEMERAL", "TTL", "INTERVAL", "DISTINCT", "ALL"],
);

/** Words a wildcard never spans: they start the next clause or column attribute. */
const CLAUSE = new Set(
  ["SELECT", "FROM", "WHERE", "PREWHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "AS", "ENGINE", "SETTINGS", "DEFAULT", "MATERIALIZED", "ALIAS", "EPHEMERAL", "CODEC", "TTL", "COMMENT", "JOIN", "ON", "USING", "UNION", "WITH"],
);

/** The tokens with grouping parentheses taken out; a call's parentheses stay. Trivia is assumed gone. */
function ungroup(tokens: readonly Token[]): Token[] {
  const out: Token[] = [];
  const grouping: boolean[] = [];
  tokens.forEach((t, i) => {
    if (isPunct(t, "(")) {
      const prev = tokens[i - 1];
      const call = (isName(prev) && !(prev!.kind === "ident" && GROUPING_AFTER.has(prev!.text.toUpperCase()))) || isPunct(prev, ")");
      grouping.push(!call);
      if (call) out.push(t);
    } else if (isPunct(t, ")")) {
      if (grouping.pop() === false) out.push(t);
    } else out.push(t);
  });
  return out;
}

/** The index past the `)` matching the `(` at `open`, and the arguments between, split at top-level commas. */
function callArgs(tokens: readonly Token[], open: number): { args: Token[][]; end: number } | undefined {
  const args: Token[][] = [[]];
  let depth = 0;
  for (let i = open + 1; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (isPunct(t, "(")) depth++;
    else if (isPunct(t, ")")) {
      if (depth === 0) return { args: args.length === 1 && args[0]!.length === 0 ? [] : args, end: i + 1 };
      depth--;
    } else if (depth === 0 && isPunct(t, ",")) {
      args.push([]);
      continue;
    }
    args[args.length - 1]!.push(t);
  }
  return undefined;
}

/** A placeholder token for parameter `n`, which can't collide with anything a statement holds. */
const placeholder = (n: number): Token => ({ kind: "ident", text: `\u0000${n}`, part: 0, start: 0, end: 0 });

/**
 * `tokens` with `params` replaced by their arguments' tokens and each call to
 * a function in `lambdas` replaced by that function's body, recursively.
 */
function expand(tokens: readonly Token[], params: ReadonlyMap<string, Token[]>, lambdas: ReadonlyMap<string, { params: string[]; body: Token[] }>, seen: ReadonlySet<string>): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (isName(t)) {
      const name = nameOf(t);
      const callee = lambdas.get(name);
      if (callee && isPunct(tokens[i + 1], "(") && !seen.has(name)) {
        const call = callArgs(tokens, i + 1);
        if (call && call.args.length === callee.params.length) {
          const bound = new Map(callee.params.map((p, n) => [p, expand(call.args[n]!, params, lambdas, seen)]));
          out.push(...expand(callee.body, bound, lambdas, new Set([...seen, name])));
          i = call.end - 1;
          continue;
        }
      }
      const arg = params.get(name);
      // A parameter is a bare name: `x`, not the `x` in `t.x` or a call `x(...)`.
      if (arg && !isPunct(tokens[i - 1], ".") && !isPunct(tokens[i + 1], "(")) {
        out.push(...arg);
        continue;
      }
    }
    out.push(t);
  }
  return out;
}

/** What to look for: the function's expanded body, with its parameters as wildcards. Undefined when nothing but a parameter is left to match. */
export function inlinedPattern(name: string, lambdas: ReadonlyMap<string, { params: string[]; body: Token[] }>): Item[] | undefined {
  const own = lambdas.get(name);
  if (!own) return undefined;
  const params = new Map(own.params.map((p, n) => [p, [placeholder(n)]]));
  const tokens = ungroup(expand(own.body, params, lambdas, new Set([name])));
  const items: Item[] = tokens.map((t) => (t.text.startsWith("\u0000") ? { arg: Number(t.text.slice(1)) } : { lit: t.text }));
  return items.some((i) => "lit" in i) ? items : undefined;
}

/** A budget on matching steps per statement, so a pathological statement can't stall an import. */
const STEP_LIMIT = 200_000;

/** Whether `pattern` appears in `statement`'s tokens. */
export function containsInlined(statement: string, pattern: readonly Item[]): boolean {
  let raw: Token[];
  try {
    raw = tokenizeText(statement, 0).filter((t) => !isTrivia(t));
  } catch {
    return false;
  }
  const text = ungroup(raw).map((t) => t.text);
  const lits = pattern.flatMap((i) => ("lit" in i ? [i.lit] : []));
  const present = new Set(text);
  if (!lits.every((l) => present.has(l))) return false;
  let steps = 0;
  const match = (p: number, at: number, bound: Map<number, string[]>): boolean => {
    if (++steps > STEP_LIMIT) return false;
    if (p === pattern.length) return true;
    const item = pattern[p]!;
    if ("lit" in item) return text[at] === item.lit && match(p + 1, at + 1, bound);
    const known = bound.get(item.arg);
    if (known) return known.every((s, k) => text[at + k] === s) && match(p + 1, at + known.length, bound);
    // One balanced expression: never past a top-level comma, an unmatched `)`, or the next clause.
    let depth = 0;
    for (let end = at; end < text.length; end++) {
      const s = text[end]!;
      if (depth === 0 && (s === "," || s === ";" || s === ")" || CLAUSE.has(s.toUpperCase()))) return false;
      if (s === "(") depth++;
      else if (s === ")") depth--;
      if (depth > 0) continue;
      bound.set(item.arg, text.slice(at, end + 1));
      if (match(p + 1, end + 1, bound)) return true;
      bound.delete(item.arg);
    }
    return false;
  };
  for (let at = 0; at < text.length; at++) if (match(0, at, new Map())) return true;
  return false;
}

/**
 * The functions among `functions` whose bodies appear inlined in any of
 * `statements`. A function is matched with the others' bodies expanded into
 * its own, as the server does.
 */
export function inlinedFunctions(statements: readonly string[], functions: ReadonlyArray<{ name: string; statement: string }>): string[] {
  const lambdas = new Map<string, { params: string[]; body: Token[] }>();
  for (const f of functions) {
    const l = functionLambda(f.statement);
    if (l) lambdas.set(f.name, l);
  }
  const out: string[] = [];
  for (const f of functions) {
    const pattern = inlinedPattern(f.name, lambdas);
    if (pattern && statements.some((s) => containsInlined(s, pattern))) out.push(f.name);
  }
  return out;
}
