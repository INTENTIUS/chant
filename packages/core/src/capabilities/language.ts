/**
 * The capability rule language (#4375, ruled on #4361).
 *
 * A capability is a named path pattern over the lexicon-neutral view
 * (`./view.ts`). Its steps are #4359's edge terms: an arrow, an optional
 * depth, then what the edge is. A rule file is data, read at run time:
 *
 *   # a comment
 *   ## meaning: what the capability says, in one line      (catalog metadata)
 *   in-sg(x, g)          := x ->{0,1}template ->sg g:SecurityGroup
 *   open-ingress(c; port?, proto?)
 *                        := c ->in-sg ->ingress :IngressRule[cidrs in ("0.0.0.0/0"), from <= $port]
 *   internet-reachable(c; port?)
 *                        := c[@internet-facing, @open-ingress($port)]
 *                         | c:Function <-function :FunctionUrl[authType = "NONE"]
 *
 * One variable makes a node set, used as `[@name]`. Two make a named edge,
 * followed as `->name` or `<-name`, which carries the hops that proved it.
 * Parameters come after `;`; a `?` makes one optional, and a test that names
 * an absent parameter is left out. Lines starting `|` add an alternative.
 *
 * A step is `->` or `<-`, an optional depth (`?`, `*`, `+`, `{n}`, `{m,n}`,
 * `{m,}`; a rule may start at 0, which #4359's query grammar refuses), an
 * edge name or `(a|b)`, and an optional node: `var:Label|Label[tests]`.
 * `!->name node` and `!<-name node` are negated steps: the walk stays where
 * it is and goes on only when no such edge leads to such a node.
 *
 * A node test is `attr = v`, `attr != v`, `attr in (v, ...)`, `attr ~ "glob"`,
 * `attr < n` (and `<=`, `>`, `>=`), a bare `attr` (present and not false),
 * or `@cap` / `@cap(args)`. Any test takes a leading `!`. Against a list
 * attribute, a test holds when it holds for any element.
 */

export type Literal = string | number | boolean | null;

/** A value in a test or an argument: a literal, or a reference to a parameter. */
export type Value = { lit: Literal } | { param: string };

export type Test =
  | { kind: "attr"; negated: boolean; attr: string; op: "=" | "!=" | "in" | "~" | "<" | "<=" | ">" | ">=" | "present"; values: Value[] }
  | { kind: "cap"; negated: boolean; cap: string; args: Value[] };

export interface NodeSpec {
  v?: string;
  labels?: string[];
  tests: Test[];
}

export interface Step {
  dir: "out" | "in";
  negated: boolean;
  /** Edge names: view edges or two-variable capabilities. */
  names: { name: string; args: Value[] }[];
  min: number;
  max: number;
  node: NodeSpec;
}

export interface Alternative {
  head: NodeSpec;
  steps: Step[];
  /** 1-based line in the rule file, for messages. */
  line: number;
}

export interface Param {
  name: string;
  optional: boolean;
}

export interface Rule {
  name: string;
  vars: string[];
  params: Param[];
  alts: Alternative[];
  /** `## key: value` lines above the rule. */
  meta: Record<string, string>;
  line: number;
  /** The rule as written, one alternative per line, comments dropped. */
  text: string;
}

/** A rule file the parser cannot read, with the line it failed on. */
export class RuleSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`line ${line}: ${message}`);
  }
}

// An identifier may hold `-` (`can-assume`), but not one that starts an arrow.
const TOKEN = /\s*(!->|!<-|->|<-|:=|<=|>=|!=|\{\d*(?:,\d*)?\}|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?![\w-])|[$]?[A-Za-z_](?:\w|-(?!>))*|[()[\],|?*+@:=~<>!;])/y;

function tokenize(text: string, line: number): string[] {
  const out: string[] = [];
  TOKEN.lastIndex = 0;
  const end = text.trimEnd().length;
  while (TOKEN.lastIndex < end) {
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(text);
    if (!m) throw new RuleSyntaxError(`cannot read "${text.slice(at).trim()}"`, line);
    out.push(m[1]);
  }
  return out;
}

/**
 * Parse a rule file. Rules may span lines: a line that starts with `|`
 * continues the rule above it, and so does an indented line when the rule's
 * `:=` has nothing after it yet.
 */
export function parseRules(text: string): Rule[] {
  const rules: Rule[] = [];
  let meta: Record<string, string> = {};
  let pending: { text: string; line: number; rule?: Rule } | undefined;
  const lines = text.split("\n");

  const flush = (): void => {
    if (!pending) return;
    const { text: body, line } = pending;
    const toks = tokenize(body, line);
    const p = new Parser(toks, line);
    if (pending.rule) {
      p.eat("|");
      pending.rule.alts.push(p.alternative());
      pending.rule.text += `\n${body.trim()}`;
    } else {
      const rule = p.header(meta, body.trim());
      meta = {};
      rule.alts.push(p.alternative());
      rules.push(rule);
    }
    p.done();
    pending = undefined;
  };

  lines.forEach((raw, i) => {
    const line = i + 1;
    const docMatch = /^\s*##\s*([\w-]+)\s*:\s*(.*)$/.exec(raw);
    if (docMatch) {
      flush();
      const [, key, value] = docMatch;
      meta[key] = meta[key] ? `${meta[key]}\n${value.trim()}` : value.trim();
      return;
    }
    const code = raw.replace(/(^|\s)#.*$/, "");
    if (!code.trim()) return;
    if (/^\s*\|/.test(code)) {
      flush();
      const rule = rules.at(-1);
      if (!rule) throw new RuleSyntaxError("an alternative needs a rule above it", line);
      pending = { text: code, line, rule };
      return;
    }
    if (/^\s/.test(code) && pending) {
      pending.text += ` ${code.trim()}`;
      return;
    }
    flush();
    pending = { text: code, line };
  });
  flush();

  const seen = new Set<string>();
  for (const r of rules) {
    if (seen.has(r.name)) throw new RuleSyntaxError(`"${r.name}" is defined twice`, r.line);
    seen.add(r.name);
  }
  return rules;
}

const LIT = (tok: string): Literal => {
  if (tok === "null") return null;
  if (tok === "true") return true;
  if (tok === "false") return false;
  if (tok.startsWith('"')) return JSON.parse(tok) as string;
  if (/^-?\d/.test(tok)) return Number(tok);
  return tok;
};

const NAME = /^[A-Za-z_][\w-]*$/;

class Parser {
  private i = 0;
  constructor(
    private readonly t: string[],
    private readonly line: number,
  ) {}

  private peek(k = 0): string | undefined {
    return this.t[this.i + k];
  }
  private next(): string {
    const tok = this.t[this.i++];
    if (tok === undefined) throw new RuleSyntaxError("the rule ends too early", this.line);
    return tok;
  }
  eat(x: string): void {
    if (this.t[this.i] !== x) {
      throw new RuleSyntaxError(`expected "${x}" at "${this.t.slice(this.i).join(" ") || "end of rule"}"`, this.line);
    }
    this.i++;
  }
  done(): void {
    if (this.i !== this.t.length) throw new RuleSyntaxError(`cannot read "${this.t.slice(this.i).join(" ")}"`, this.line);
  }
  private name(what: string): string {
    const tok = this.next();
    if (!NAME.test(tok)) throw new RuleSyntaxError(`expected ${what}, found "${tok}"`, this.line);
    return tok;
  }

  header(meta: Record<string, string>, text: string): Rule {
    const name = this.name("a capability name");
    this.eat("(");
    const vars = [this.name("a variable")];
    if (this.peek() === ",") {
      this.next();
      vars.push(this.name("a variable"));
    }
    const params: Param[] = [];
    if (this.peek() === ";") {
      this.next();
      for (;;) {
        const p = this.name("a parameter");
        const optional = this.peek() === "?";
        if (optional) this.next();
        params.push({ name: p, optional });
        if (this.peek() !== ",") break;
        this.next();
      }
    }
    this.eat(")");
    this.eat(":=");
    return { name, vars, params, alts: [], meta, line: this.line, text };
  }

  alternative(): Alternative {
    const head = this.node();
    const steps: Step[] = [];
    while (this.peek() && /^!?(->|<-)$/.test(this.peek()!)) steps.push(this.step());
    return { head, steps, line: this.line };
  }

  private step(): Step {
    const arrow = this.next();
    const negated = arrow.startsWith("!");
    const dir = arrow.endsWith("->") ? "out" : "in";
    let min = 1;
    let max = 1;
    const q = this.peek();
    if (q === "?") {
      this.next();
      min = 0;
    } else if (q === "*") {
      this.next();
      max = Infinity;
    } else if (q === "+") {
      this.next();
      max = Infinity;
    } else if (q && q.startsWith("{")) {
      this.next();
      const m = /^\{(\d*)(,(\d*))?\}$/.exec(q)!;
      min = m[1] === "" ? 0 : Number(m[1]);
      max = m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]);
      if (max < min) throw new RuleSyntaxError(`depth ${q} has its maximum below its minimum`, this.line);
    }
    if (negated && (min !== 1 || max !== 1)) throw new RuleSyntaxError("a negated step takes no depth", this.line);
    const names: Step["names"] = [];
    if (this.peek() === "(") {
      this.next();
      for (;;) {
        names.push(this.edgeName());
        if (this.peek() !== "|") break;
        this.next();
      }
      this.eat(")");
    } else names.push(this.edgeName());
    return { dir, negated, names, min, max, node: this.node() };
  }

  private edgeName(): { name: string; args: Value[] } {
    const name = this.name("an edge name");
    // `->grants($action)`: arguments must touch the name, so a following
    // `(a|b)` step is not read as arguments.
    return { name, args: this.peek() === "(" ? this.args() : [] };
  }

  private args(): Value[] {
    this.eat("(");
    const out: Value[] = [];
    while (this.peek() !== ")") {
      out.push(this.value());
      if (this.peek() === ",") this.next();
    }
    this.eat(")");
    return out;
  }

  private value(): Value {
    const tok = this.next();
    if (tok.startsWith("$")) return { param: tok.slice(1) };
    return { lit: LIT(tok) };
  }

  private node(): NodeSpec {
    const spec: NodeSpec = { tests: [] };
    const p = this.peek();
    if (p && NAME.test(p) && /^[a-z_]/.test(p) && this.peek(1) !== "(") {
      spec.v = this.next();
    }
    if (this.peek() === ":") {
      this.next();
      spec.labels = [this.name("a label")];
      while (this.peek() === "|" && /^[A-Z]/.test(this.peek(1) ?? "")) {
        this.next();
        spec.labels.push(this.name("a label"));
      }
    }
    if (this.peek() === "[") {
      this.next();
      while (this.peek() !== "]") {
        spec.tests.push(this.test());
        if (this.peek() === ",") this.next();
        else if (this.peek() !== "]") throw new RuleSyntaxError(`expected "," or "]" at "${this.peek() ?? "end of rule"}"`, this.line);
      }
      this.eat("]");
    }
    return spec;
  }

  private test(): Test {
    let negated = false;
    if (this.peek() === "!") {
      this.next();
      negated = true;
    }
    if (this.peek() === "@") {
      this.next();
      const cap = this.name("a capability name");
      return { kind: "cap", negated, cap, args: this.peek() === "(" ? this.args() : [] };
    }
    const attr = this.name("an attribute");
    const op = this.peek();
    if (op === "," || op === "]") return { kind: "attr", negated, attr, op: "present", values: [] };
    this.next();
    if (op === "in") {
      return { kind: "attr", negated, attr, op: "in", values: this.args() };
    }
    if (op === "=" || op === "!=" || op === "~" || op === "<" || op === "<=" || op === ">" || op === ">=") {
      return { kind: "attr", negated, attr, op, values: [this.value()] };
    }
    throw new RuleSyntaxError(`"${op}" is not a test operator`, this.line);
  }
}

/** The capabilities a rule refers to, by name: in `[@cap]` tests and in steps. */
export function ruleDependencies(rule: Rule): Set<string> {
  const out = new Set<string>();
  const node = (n: NodeSpec): void => {
    for (const t of n.tests) if (t.kind === "cap") out.add(t.cap);
  };
  for (const a of rule.alts) {
    node(a.head);
    for (const s of a.steps) {
      for (const n of s.names) out.add(n.name);
      node(s.node);
    }
  }
  return out;
}
