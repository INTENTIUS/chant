/**
 * Reading a parsed PromQL expression: the selectors it reads, the labels its
 * result keeps, and whether it filters with a comparison. The rule-file
 * checks PROM211-PROM219 (./validate-config.ts) are built on these.
 *
 * The tree is the one `checkPromql` (./promql.ts) parses with
 * `@prometheus-io/lezer-promql`. Every function here returns nothing for an
 * expression that does not parse; PROM104 reports that.
 */

import { parser } from "@prometheus-io/lezer-promql";
import type { MatchOp } from "./matchers";

type SyntaxNode = ReturnType<typeof parser.parse>["topNode"];

/** The expression under the tree's `PromQL` root, or undefined when it does not parse. */
export function parsePromql(expr: string): SyntaxNode | undefined {
  if (typeof expr !== "string" || expr.trim() === "") return undefined;
  const tree = parser.parse(expr);
  let broken = false;
  tree.iterate({
    enter: (n) => {
      if (n.type.isError) broken = true;
      return broken ? false : undefined;
    },
  });
  return broken ? undefined : (tree.topNode.firstChild ?? undefined);
}

function text(n: SyntaxNode, src: string): string {
  return src.slice(n.from, n.to);
}

/** The value of a PromQL string literal: double- or single-quoted with escapes, or a raw backtick string. */
export function stringValue(literal: string): string {
  if (literal.startsWith("`")) return literal.slice(1, -1);
  const body = literal.slice(1, -1);
  try {
    return JSON.parse(`"${literal.startsWith("'") ? body.replace(/\\'/g, "'").replace(/"/g, '\\"') : body}"`) as string;
  } catch {
    return body;
  }
}

function children(n: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let c = n.firstChild; c; c = c.nextSibling) out.push(c);
  return out;
}

/** The arguments of a function call or aggregation body, without the brackets and commas. */
function args(body: SyntaxNode | null): SyntaxNode[] {
  return body ? children(body).filter((c) => c.name !== "(" && c.name !== ")" && c.name !== ",") : [];
}

function unwrap(n: SyntaxNode): SyntaxNode {
  let cur = n;
  while (cur.name === "ParenExpr" && cur.firstChild) cur = children(cur).find((c) => c.name !== "(" && c.name !== ")") ?? cur;
  return cur;
}

export interface SelectorMatcher {
  name: string;
  op: MatchOp;
  value: string;
}

/** One vector selector in an expression. */
export interface Selector {
  /** The metric name, from the identifier or a `__name__="..."` matcher; undefined when neither names one. */
  name?: string;
  matchers: SelectorMatcher[];
  /** The selector as written. */
  text: string;
  /** The functions it sits inside, innermost first, e.g. `["rate", "sum"]` for `sum(rate(x[5m]))`. */
  within: string[];
}

function selectorOf(n: SyntaxNode, src: string, within: string[]): Selector {
  const matchers: SelectorMatcher[] = [];
  const list = n.getChild("LabelMatchers");
  for (const c of list ? children(list) : []) {
    if (c.name !== "UnquotedLabelMatcher" && c.name !== "QuotedLabelMatcher") continue;
    const label = c.getChild("LabelName") ?? c.getChild("QuotedLabelName");
    const op = c.getChild("MatchOp");
    const value = c.getChild("StringLiteral");
    if (!label || !op || !value) continue;
    const name = label.name === "QuotedLabelName" ? stringValue(text(label, src)) : text(label, src);
    matchers.push({ name, op: text(op, src) as MatchOp, value: stringValue(text(value, src)) });
  }
  const ident = n.getChild("Identifier");
  const byName = matchers.find((m) => m.name === "__name__" && m.op === "=");
  const name = ident ? text(ident, src) : byName?.value;
  return { name, matchers, text: text(n, src), within };
}

/** The name of a function call or aggregation node, e.g. `rate` or `sum`. */
function callName(n: SyntaxNode, src: string): string | undefined {
  if (n.name === "FunctionCall") {
    const id = n.getChild("FunctionIdentifier");
    return id ? text(id, src) : undefined;
  }
  if (n.name === "AggregateExpr") {
    const op = n.getChild("AggregateOp");
    return op ? text(op, src) : undefined;
  }
  return undefined;
}

/** Every vector selector in the expression, with the functions around it. */
export function selectors(expr: string): Selector[] {
  const top = parsePromql(expr);
  if (!top) return [];
  const out: Selector[] = [];
  const walk = (n: SyntaxNode, within: string[]) => {
    if (n.name === "VectorSelector") {
      out.push(selectorOf(n, expr, within));
      return;
    }
    const fn = callName(n, expr);
    const inner = fn ? [fn, ...within] : within;
    for (const c of children(n)) walk(c, inner);
  };
  walk(top, []);
  return out;
}

const COMPARISON = new Set(["Gtr", "Lss", "Gte", "Lte", "Eql", "Neq"]);

function binaryParts(n: SyntaxNode): { lhs: SyntaxNode; op: SyntaxNode; rhs: SyntaxNode; bool: boolean; modifier?: SyntaxNode } {
  const parts = children(n);
  return {
    lhs: parts[0],
    op: parts[1],
    rhs: parts[parts.length - 1],
    bool: parts.some((p) => p.name === "BoolModifier"),
    modifier: parts.find((p) => p.name === "MatchingModifierClause"),
  };
}

/** Functions whose result is itself a condition: they return a series only when something is missing. */
const CONDITION_FUNCTIONS = new Set(["absent", "absent_over_time"]);

/**
 * Whether the expression filters its result: a comparison without `bool`,
 * `absent()`/`absent_over_time()`, or `unless`, anywhere a series can pass
 * through to the result. An expression without one returns every series it
 * reads, so an alert on it fires for all of them (pint alerts/comparison).
 * `or` needs a condition on both sides, since either side alone reaches the
 * result.
 */
export function hasCondition(expr: string): boolean | undefined {
  const top = parsePromql(expr);
  if (!top) return undefined;
  const walk = (raw: SyntaxNode): boolean => {
    const n = unwrap(raw);
    switch (n.name) {
      case "BinaryExpr": {
        const { lhs, op, rhs, bool } = binaryParts(n);
        if (COMPARISON.has(op.name)) return !bool || walk(lhs) || walk(rhs);
        if (op.name === "Unless") return true;
        if (op.name === "Or") return walk(lhs) && walk(rhs);
        return walk(lhs) || walk(rhs);
      }
      case "FunctionCall": {
        const fn = callName(n, expr) ?? "";
        if (CONDITION_FUNCTIONS.has(fn)) return true;
        return args(n.getChild("FunctionCallBody")).some(walk);
      }
      case "AggregateExpr":
        return args(n.getChild("FunctionCallBody")).some(walk);
      case "UnaryExpr":
      case "OffsetExpr":
      case "StepInvariantExpr":
        return children(n).some(walk);
      case "SubqueryExpr":
      case "MatrixSelector":
        return n.firstChild ? walk(n.firstChild) : false;
      default:
        return false;
    }
  };
  return walk(top);
}

/**
 * The labels an expression's result carries, as far as the expression says:
 * `{ only }` when it keeps exactly these labels (`sum by (job)`), `{ except }`
 * when it keeps every label but these (`sum without (instance)`), or
 * undefined when it keeps whatever the series it reads carry.
 */
export type LabelScope = { only: Set<string> } | { except: Set<string> };

const KEEPS_INPUT_LABELS = new Set(["topk", "bottomk", "limitk", "limit_ratio"]);
const NO_LABELS = new Set(["vector", "time", "scalar", "pi"]);

function grouping(mod: SyntaxNode | null, src: string): { by: boolean; labels: string[] } | undefined {
  if (!mod) return undefined;
  const labels = (mod.getChild("GroupingLabels")?.getChildren("LabelName") ?? []).map((l) => text(l, src));
  return { by: !!mod.getChild("By"), labels };
}

function minus(scope: LabelScope | undefined, drop: string[]): LabelScope {
  if (!scope) return { except: new Set(drop) };
  if ("only" in scope) return { only: new Set([...scope.only].filter((l) => !drop.includes(l))) };
  return { except: new Set([...scope.except, ...drop]) };
}

function plus(scope: LabelScope | undefined, add: string[]): LabelScope | undefined {
  if (!scope) return undefined;
  if ("only" in scope) return { only: new Set([...scope.only, ...add]) };
  return { except: new Set([...scope.except].filter((l) => !add.includes(l))) };
}

/** The labels the expression's result keeps; see {@link LabelScope}. */
export function resultLabels(expr: string): LabelScope | undefined {
  const top = parsePromql(expr);
  if (!top) return undefined;
  const walk = (raw: SyntaxNode): LabelScope | undefined => {
    const n = unwrap(raw);
    switch (n.name) {
      case "NumberDurationLiteral":
      case "StringLiteral":
        return { only: new Set() };
      case "AggregateExpr": {
        const op = callName(n, expr) ?? "";
        const body = args(n.getChild("FunctionCallBody"));
        const last = body[body.length - 1];
        const inner = last ? walk(last) : undefined;
        if (KEEPS_INPUT_LABELS.has(op)) return inner;
        if (op === "count_values") return undefined;
        const g = grouping(n.getChild("AggregateModifier"), expr);
        if (!g) return { only: new Set() };
        return g.by ? { only: new Set(g.labels) } : minus(inner, g.labels);
      }
      case "FunctionCall": {
        const fn = callName(n, expr) ?? "";
        if (NO_LABELS.has(fn)) return { only: new Set() };
        const a = args(n.getChild("FunctionCallBody"));
        if (fn === "histogram_quantile" || fn === "histogram_fraction") return minus(walk(a[a.length - 1]), ["le"]);
        if (fn === "label_replace" || fn === "label_join") {
          const dst = a[1]?.name === "StringLiteral" ? stringValue(text(a[1], expr)) : undefined;
          return dst === undefined ? undefined : plus(walk(a[0]), [dst]);
        }
        if (CONDITION_FUNCTIONS.has(fn)) return undefined;
        const vector = a.find((x) => x.name !== "NumberDurationLiteral" && x.name !== "StringLiteral");
        return vector ? walk(vector) : { only: new Set() };
      }
      case "BinaryExpr": {
        const { lhs, op, rhs, modifier } = binaryParts(n);
        const l = walk(lhs);
        const r = walk(rhs);
        const lScalar = unwrap(lhs).name === "NumberDurationLiteral";
        const rScalar = unwrap(rhs).name === "NumberDurationLiteral";
        if (lScalar && !rScalar) return r;
        if (rScalar) return l;
        if (op.name === "And" || op.name === "Unless") return l;
        if (op.name === "Or") {
          if (l && r && "only" in l && "only" in r) return { only: new Set([...l.only, ...r.only]) };
          return undefined;
        }
        if (!modifier) return l;
        const on = !!modifier.getChild("On");
        const groupLabels = modifier.getChildren("GroupingLabels").map((g) => g.getChildren("LabelName").map((x) => text(x, expr)));
        const matching = groupLabels[0] ?? [];
        const extra = groupLabels[1] ?? [];
        if (modifier.getChild("GroupLeft")) return plus(l, extra);
        if (modifier.getChild("GroupRight")) return plus(r, extra);
        // One-to-one: `on` keeps only the matching labels, `ignoring` drops them.
        return on ? { only: new Set(matching.filter((x) => !l || ("only" in l ? l.only.has(x) : !l.except.has(x)))) } : minus(l, matching);
      }
      case "UnaryExpr":
      case "OffsetExpr":
      case "StepInvariantExpr":
        return walk(children(n).find((c) => c.name !== "UnaryOp" && c.name !== "Offset" && c.name !== "OffsetDurationExpr") ?? n.firstChild!);
      default:
        return undefined;
    }
  };
  return walk(top);
}

/** Whether a label survives a scope. An undefined scope keeps every label. */
export function keepsLabel(scope: LabelScope | undefined, label: string): boolean {
  if (!scope) return true;
  return "only" in scope ? scope.only.has(label) : !scope.except.has(label);
}

/** One `histogram_quantile` call and what is wrong with its histogram argument. */
export interface HistogramProblem {
  call: string;
  problem: "no-bucket" | "no-le";
}

/** `histogram_quantile` calls over a selector with no `_bucket` in its name, or an aggregation that drops `le`. */
export function histogramProblems(expr: string): HistogramProblem[] {
  const top = parsePromql(expr);
  if (!top) return [];
  const out: HistogramProblem[] = [];
  const walk = (n: SyntaxNode) => {
    if (n.name === "FunctionCall" && callName(n, expr) === "histogram_quantile") {
      const a = args(n.getChild("FunctionCallBody"));
      const histogram = a[1];
      if (histogram) {
        const call = text(n, expr);
        const names = selectors(text(histogram, expr)).flatMap((s) => (s.name ? [s.name] : []));
        if (names.some((x) => !x.includes("_bucket"))) out.push({ call, problem: "no-bucket" });
        else if (!keepsLabel(resultLabels(text(histogram, expr)), "le")) out.push({ call, problem: "no-le" });
      }
    }
    for (const c of children(n)) walk(c);
  };
  walk(top);
  return out;
}

const COUNTER_FUNCTIONS = new Set(["rate", "irate", "increase"]);
const COUNTER_SUFFIX = /_(total|count|sum|bucket)$/;

/** `rate`, `irate` or `increase` read straight from a named selector whose name does not end in a counter suffix. */
export function nonCounterRates(expr: string): Array<{ fn: string; name: string }> {
  return selectors(expr).flatMap((s) => {
    const fn = s.within[0];
    if (!fn || !COUNTER_FUNCTIONS.has(fn) || !s.name || COUNTER_SUFFIX.test(s.name)) return [];
    return [{ fn, name: s.name }];
  });
}

const REGEX_META = /[.+*?()[\]{}|\\^$]/;

/** A regex matcher that could be an equality matcher, or that carries anchors Prometheus already adds. */
export interface RegexProblem {
  matcher: string;
  problem: "literal" | "anchored";
}

/** The `=~` and `!~` matchers in an expression that need no regex, or that are anchored (pint promql/regexp). */
export function regexProblems(expr: string): RegexProblem[] {
  const out: RegexProblem[] = [];
  for (const s of selectors(expr)) {
    for (const m of s.matchers) {
      if (m.op !== "=~" && m.op !== "!~") continue;
      const shown = `${m.name}${m.op}${JSON.stringify(m.value)}`;
      if (!REGEX_META.test(m.value)) out.push({ matcher: shown, problem: "literal" });
      else if (m.value.startsWith("^") || (m.value.endsWith("$") && !m.value.endsWith("\\$"))) out.push({ matcher: shown, problem: "anchored" });
    }
  }
  return out;
}

/** Whether every selector in the expression is read through a `*_over_time` function, so the expression already spans a window. */
export function readsOnlyOverTime(expr: string): boolean {
  const all = selectors(expr);
  return all.length > 0 && all.every((s) => s.within.some((fn) => fn.endsWith("_over_time")));
}

/** Whether the expression is two conditions joined by `and`: the multi-window form, where the short window does what `for` would. */
export function isMultiWindow(expr: string): boolean {
  const top = parsePromql(expr);
  if (!top) return false;
  const n = unwrap(top);
  if (n.name !== "BinaryExpr") return false;
  const { lhs, op, rhs } = binaryParts(n);
  return op.name === "And" && hasCondition(text(lhs, expr)) === true && hasCondition(text(rhs, expr)) === true;
}
