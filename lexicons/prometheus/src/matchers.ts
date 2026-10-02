/**
 * Alertmanager label matchers: `severity="critical"`, `team=~"db|infra"`,
 * `env!="dev"`.
 *
 * A matcher is a label name, an operator (`=`, `!=`, `=~`, `!~`) and a value,
 * quoted or not. One list entry may also hold several comma-separated
 * matchers in braces (`{a="1", b="2"}`), which Alertmanager accepts too.
 * Regex values are anchored at both ends, as Alertmanager anchors them.
 */

export type MatchOp = "=" | "!=" | "=~" | "!~";

export interface Matcher {
  name: string;
  op: MatchOp;
  value: string;
}

export type ParsedMatchers = { ok: true; matchers: Matcher[] } | { ok: false; error: string };

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function readQuoted(s: string, start: number): { value: string; end: number } | undefined {
  let i = start + 1;
  let out = "";
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      const next = s[i + 1];
      if (next === undefined) return undefined;
      out += next === "n" ? "\n" : next === "t" ? "\t" : next;
      i += 2;
      continue;
    }
    if (c === '"') return { value: out, end: i + 1 };
    out += c;
    i++;
  }
  return undefined;
}

function parseOne(text: string): Matcher | string {
  const s = text.trim();
  const opMatch = /(=~|!~|!=|=)/.exec(s);
  if (!opMatch) return `"${s}" has no operator; use =, !=, =~ or !~`;
  let name = s.slice(0, opMatch.index).trim();
  if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) name = name.slice(1, -1);
  else if (!NAME.test(name)) return `"${name}" is not a label name`;
  if (name === "") return `"${s}" has an empty label name`;
  const op = opMatch[1] as MatchOp;
  const rest = s.slice(opMatch.index + op.length).trim();
  let value: string;
  if (rest.startsWith('"')) {
    const q = readQuoted(rest, 0);
    if (!q) return `"${s}" has an unterminated quoted value`;
    if (rest.slice(q.end).trim() !== "") return `"${s}" has text after its quoted value`;
    value = q.value;
  } else {
    if (/["{}=!~,]/.test(rest)) return `"${s}" has an unquoted value with reserved characters; quote it`;
    value = rest;
  }
  if (op === "=~" || op === "!~") {
    try {
      new RegExp(`^(?:${value})$`);
    } catch (err) {
      return `"${s}" has an invalid regular expression: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return { name, op, value };
}

/** Split `a="x,y", b=z` on the commas that are outside quotes. */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depthQuote = false;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && depthQuote) {
      cur += c + (s[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === '"') depthQuote = !depthQuote;
    if (c === "," && !depthQuote) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

/** Parse one entry of a `matchers:` list. */
export function parseMatchers(entry: string): ParsedMatchers {
  let s = entry.trim();
  if (s === "") return { ok: false, error: "empty matcher" };
  if (s.startsWith("{")) {
    if (!s.endsWith("}")) return { ok: false, error: `"${entry}" opens a brace it never closes` };
    s = s.slice(1, -1);
  }
  const matchers: Matcher[] = [];
  for (const part of splitTopLevel(s)) {
    const m = parseOne(part);
    if (typeof m === "string") return { ok: false, error: m };
    matchers.push(m);
  }
  if (matchers.length === 0) return { ok: false, error: `"${entry}" holds no matcher` };
  return { ok: true, matchers };
}

/** Whether one matcher matches a label set (a missing label reads as the empty string, as in Alertmanager). */
export function matcherMatches(m: Matcher, labels: Record<string, string>): boolean {
  const v = labels[m.name] ?? "";
  switch (m.op) {
    case "=":
      return v === m.value;
    case "!=":
      return v !== m.value;
    case "=~":
      return new RegExp(`^(?:${m.value})$`).test(v);
    case "!~":
      return !new RegExp(`^(?:${m.value})$`).test(v);
  }
}

/** Build the matcher string for `name op value`, quoting the value. */
export function matcher(name: string, op: MatchOp, value: string): string {
  return `${name}${op}${JSON.stringify(value)}`;
}
