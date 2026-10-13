/**
 * A small rule-file evaluator, for tests over synthetic series.
 *
 * It evaluates recording and alerting rules the way Prometheus does, one
 * evaluation step at a time: each group's rules in order, recording rule
 * results written back as series the later rules (and later steps) read.
 * The PromQL it understands is the subset the lexicon's generated rules use:
 * number literals, vector and range selectors with `=`, `!=`, `=~` and `!~`
 * matchers, `rate`, `increase`, `avg_over_time`, `sum_over_time`,
 * `count_over_time`, `vector`, `histogram_quantile`, `sum` (with `by` or
 * `without`), the arithmetic and comparison operators (one-to-one, or
 * many-to-one with `group_left` and no extra labels) and `and`, `or` and
 * `unless` (with `on` or `ignoring`). Anything else throws, so a test never
 * passes by silently evaluating something it does not understand.
 *
 * `histogram_quantile` interpolates linearly inside the bucket the rank
 * falls in, as Prometheus does for classic buckets, and returns the upper
 * bound of the highest finite bucket when the rank falls in `+Inf`.
 *
 * `rate` is the increase between the first and last sample in the range
 * over the time between them, without Prometheus's extrapolation to the
 * range's edges. For two counters sampled together that changes neither's
 * ratio, which is what an SLI is. `promtool test rules`, when installed,
 * checks the same rules with Prometheus's own engine.
 *
 * Not exported from the package root; tests import it by path.
 */

import { parser } from "@prometheus-io/lezer-promql";
import { durationMs } from "./duration";
import { isAlertingRuleConfig, isRecordingRuleConfig, type LabelSet, type RuleGroupConfig } from "./model";

type SyntaxNode = ReturnType<typeof parser.parse>["topNode"];

export type Labels = Record<string, string>;
export interface Sample {
  t: number;
  v: number;
}
export interface Series {
  labels: Labels;
  samples: Sample[];
}
export interface VectorElement {
  labels: Labels;
  value: number;
}
type Value = { kind: "scalar"; value: number } | { kind: "vector"; elements: VectorElement[] };

/** One firing alert at one evaluation. */
export interface FiringAlert {
  labels: Labels;
  value: number;
}

const LOOKBACK_MS = 5 * 60_000;
const RANGE_FUNCTIONS = new Set(["rate", "increase", "avg_over_time", "sum_over_time", "count_over_time"]);

function key(labels: Labels): string {
  return JSON.stringify(Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function withoutName(labels: Labels): Labels {
  const { __name__: _, ...rest } = labels;
  return rest;
}

interface Matcher {
  name: string;
  op: "=" | "!=" | "=~" | "!~";
  value: string;
}

function matches(labels: Labels, m: Matcher): boolean {
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

/** An in-memory series store with rule evaluation over it. */
export class RuleEvaluator {
  private readonly series = new Map<string, Series>();
  /** When each active alert started, per alerting rule. */
  private readonly pending = new Map<object, Map<string, number>>();

  constructor(private readonly groups: RuleGroupConfig[]) {}

  /** Append one sample; samples of a series must arrive in time order. */
  add(labels: Labels, t: number, v: number): void {
    const k = key(labels);
    let s = this.series.get(k);
    if (!s) {
      s = { labels: { ...labels }, samples: [] };
      this.series.set(k, s);
    }
    s.samples.push({ t, v });
  }

  /** Evaluate every group at time `t` (milliseconds); returns the alerts firing at `t`. */
  step(t: number): FiringAlert[] {
    const firing: FiringAlert[] = [];
    for (const group of this.groups) {
      const groupLabels: LabelSet = group.labels ?? {};
      for (const rule of group.rules) {
        const result = this.eval(rule.expr, t);
        const elements = result.kind === "scalar" ? [{ labels: {}, value: result.value }] : result.elements;
        if (isRecordingRuleConfig(rule)) {
          for (const e of elements) {
            if (Number.isNaN(e.value)) continue;
            this.add({ ...withoutName(e.labels), ...groupLabels, ...(rule.labels ?? {}), __name__: rule.record }, t, e.value);
          }
        } else if (isAlertingRuleConfig(rule)) {
          const before = this.pending.get(rule) ?? new Map<string, number>();
          const now = new Map<string, number>();
          const holdMs = rule.for ? (durationMs(rule.for) ?? 0) : 0;
          for (const e of elements) {
            const labels = { ...withoutName(e.labels), ...groupLabels, ...(rule.labels ?? {}), alertname: rule.alert };
            const k = key(labels);
            const since = before.get(k) ?? t;
            now.set(k, since);
            if (t - since >= holdMs) firing.push({ labels, value: e.value });
          }
          this.pending.set(rule, now);
        }
      }
    }
    return firing;
  }

  /** The latest value of each series matching `selector` at `t`, e.g. `slo:x{slo="a"}`. */
  query(expr: string, t: number): VectorElement[] {
    const v = this.eval(expr, t);
    return v.kind === "scalar" ? [{ labels: {}, value: v.value }] : v.elements;
  }

  private eval(expr: string, t: number): Value {
    const tree = parser.parse(expr);
    const top = tree.topNode.firstChild;
    if (!top) throw new Error(`rule-eval: empty expression`);
    return this.node(top, expr, t);
  }

  private text(n: SyntaxNode, src: string): string {
    return src.slice(n.from, n.to);
  }

  private matchers(sel: SyntaxNode, src: string): Matcher[] {
    const out: Matcher[] = [];
    const ident = sel.getChild("Identifier");
    if (ident) out.push({ name: "__name__", op: "=", value: this.text(ident, src) });
    const list = sel.getChild("LabelMatchers");
    if (list) {
      for (let c = list.firstChild; c; c = c.nextSibling) {
        if (c.name !== "UnquotedLabelMatcher") continue;
        const name = this.text(c.getChild("LabelName")!, src);
        const op = this.text(c.getChild("MatchOp")!, src) as Matcher["op"];
        const value = JSON.parse(this.text(c.getChild("StringLiteral")!, src).replace(/^'|'$/g, '"')) as string;
        out.push({ name, op, value });
      }
    }
    return out;
  }

  private select(ms: Matcher[]): Series[] {
    return [...this.series.values()].filter((s) => ms.every((m) => matches(s.labels, m)));
  }

  /** Samples in (t - range, t]. */
  private window(s: Series, t: number, rangeMs: number): Sample[] {
    const xs = s.samples;
    let lo = 0;
    let hi = xs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid].t <= t - rangeMs) lo = mid + 1;
      else hi = mid;
    }
    const out: Sample[] = [];
    for (let i = lo; i < xs.length && xs[i].t <= t; i++) out.push(xs[i]);
    return out;
  }

  private node(n: SyntaxNode, src: string, t: number): Value {
    switch (n.name) {
      case "NumberDurationLiteral":
        return { kind: "scalar", value: Number(this.text(n, src)) };
      case "ParenExpr":
        return this.node(n.firstChild!, src, t);
      case "VectorSelector": {
        const elements: VectorElement[] = [];
        for (const s of this.select(this.matchers(n, src))) {
          const w = this.window(s, t, LOOKBACK_MS);
          if (w.length > 0) elements.push({ labels: { ...s.labels }, value: w[w.length - 1].v });
        }
        return { kind: "vector", elements };
      }
      case "FunctionCall":
        return this.call(n, src, t);
      case "AggregateExpr":
        return this.aggregate(n, src, t);
      case "BinaryExpr":
        return this.binary(n, src, t);
      default:
        throw new Error(`rule-eval: ${n.name} (${this.text(n, src)}) is not supported`);
    }
  }

  private args(body: SyntaxNode): SyntaxNode[] {
    const out: SyntaxNode[] = [];
    for (let c = body.firstChild; c; c = c.nextSibling) {
      if (c.name !== "(" && c.name !== ")" && c.name !== ",") out.push(c);
    }
    return out;
  }

  private call(n: SyntaxNode, src: string, t: number): Value {
    const fn = this.text(n.getChild("FunctionIdentifier")!, src);
    const [arg, second] = this.args(n.getChild("FunctionCallBody")!);
    if (fn === "histogram_quantile") return this.histogramQuantile(arg, second, src, t);
    if (fn === "vector") {
      const v = this.node(arg, src, t);
      if (v.kind !== "scalar") throw new Error("rule-eval: vector() takes a scalar");
      return { kind: "vector", elements: [{ labels: {}, value: v.value }] };
    }
    // Checked before any series is read, so an unsupported function throws even over no data.
    if (!RANGE_FUNCTIONS.has(fn)) throw new Error(`rule-eval: function ${fn} is not supported`);
    if (arg.name !== "MatrixSelector") throw new Error(`rule-eval: ${fn}() needs a range selector`);
    const rangeMs = durationMs(this.text(arg.getChild("DurationExpr")!, src));
    if (rangeMs === undefined) throw new Error(`rule-eval: bad range in ${this.text(arg, src)}`);
    const elements: VectorElement[] = [];
    for (const s of this.select(this.matchers(arg.getChild("VectorSelector")!, src))) {
      const w = this.window(s, t, rangeMs);
      let value: number;
      switch (fn) {
        case "rate":
        case "increase": {
          if (w.length < 2) continue;
          const inc = w[w.length - 1].v - w[0].v;
          value = fn === "rate" ? inc / ((w[w.length - 1].t - w[0].t) / 1000) : (inc * rangeMs) / (w[w.length - 1].t - w[0].t);
          break;
        }
        case "avg_over_time":
        case "sum_over_time":
        case "count_over_time": {
          if (w.length === 0) continue;
          const sum = w.reduce((a, x) => a + x.v, 0);
          value = fn === "sum_over_time" ? sum : fn === "count_over_time" ? w.length : sum / w.length;
          break;
        }
        default:
          throw new Error(`rule-eval: function ${fn} is not supported`);
      }
      elements.push({ labels: withoutName(s.labels), value });
    }
    return { kind: "vector", elements };
  }

  private histogramQuantile(qNode: SyntaxNode, vNode: SyntaxNode, src: string, t: number): Value {
    const q = this.node(qNode, src, t);
    const v = this.node(vNode, src, t);
    if (q.kind !== "scalar" || v.kind !== "vector") throw new Error("rule-eval: histogram_quantile takes a scalar and a vector");
    const groups = new Map<string, { labels: Labels; buckets: { le: number; count: number }[] }>();
    for (const e of v.elements) {
      const { le, ...rest } = withoutName(e.labels);
      if (le === undefined) continue;
      const k = key(rest);
      const g = groups.get(k) ?? { labels: rest, buckets: [] };
      g.buckets.push({ le: le === "+Inf" ? Infinity : Number(le), count: e.value });
      groups.set(k, g);
    }
    const elements: VectorElement[] = [];
    for (const { labels, buckets } of groups.values()) {
      buckets.sort((a, b) => a.le - b.le);
      const last = buckets[buckets.length - 1];
      if (!last || last.le !== Infinity) continue;
      const total = last.count;
      let value: number;
      if (q.value < 0) value = -Infinity;
      else if (q.value > 1) value = Infinity;
      else if (!(total > 0)) value = NaN;
      else {
        const rank = q.value * total;
        const i = buckets.findIndex((b) => b.count >= rank);
        if (buckets[i].le === Infinity) value = buckets.length > 1 ? buckets[buckets.length - 2].le : NaN;
        else {
          const start = i === 0 ? 0 : buckets[i - 1].le;
          const below = i === 0 ? 0 : buckets[i - 1].count;
          const inBucket = buckets[i].count - below;
          value = inBucket > 0 ? start + (buckets[i].le - start) * ((rank - below) / inBucket) : buckets[i].le;
        }
      }
      elements.push({ labels, value });
    }
    return { kind: "vector", elements };
  }

  private aggregate(n: SyntaxNode, src: string, t: number): Value {
    const op = this.text(n.getChild("AggregateOp")!, src);
    if (op !== "sum") throw new Error(`rule-eval: aggregation ${op} is not supported`);
    const mod = n.getChild("AggregateModifier");
    let by: string[] | undefined;
    let without: string[] | undefined;
    if (mod) {
      const names = (mod.getChild("GroupingLabels")?.getChildren("LabelName") ?? []).map((l) => this.text(l, src));
      if (mod.getChild("By")) by = names;
      else without = names;
    }
    const [arg] = this.args(n.getChild("FunctionCallBody")!);
    const v = this.node(arg, src, t);
    if (v.kind !== "vector") throw new Error("rule-eval: sum() takes a vector");
    const groups = new Map<string, VectorElement>();
    for (const e of v.elements) {
      const base = withoutName(e.labels);
      const labels: Labels = {};
      if (by) for (const l of by) if (base[l] !== undefined) labels[l] = base[l];
      if (without) for (const [k, val] of Object.entries(base)) if (!without.includes(k)) labels[k] = val;
      const k = key(labels);
      const g = groups.get(k);
      if (g) g.value += e.value;
      else groups.set(k, { labels, value: e.value });
    }
    return { kind: "vector", elements: [...groups.values()] };
  }

  private binary(n: SyntaxNode, src: string, t: number): Value {
    const parts: SyntaxNode[] = [];
    for (let c = n.firstChild; c; c = c.nextSibling) parts.push(c);
    const lhsNode = parts[0];
    const rhsNode = parts[parts.length - 1];
    const opNode = parts[1];
    const op = this.text(opNode, src);
    const modifier = parts.find((p) => p.name === "MatchingModifierClause");
    if (parts.some((p) => p.name === "BoolModifier")) throw new Error("rule-eval: bool modifier is not supported");
    let on: string[] | undefined;
    let ignoring: string[] = [];
    let groupLeft = false;
    if (modifier) {
      const grouping = modifier.getChild("GroupingLabels");
      const names = (grouping?.getChildren("LabelName") ?? []).map((l) => this.text(l, src));
      if (modifier.getChild("On")) on = names;
      else ignoring = names;
      if (modifier.getChild("GroupRight")) throw new Error("rule-eval: group_right is not supported");
      const left = modifier.getChild("GroupLeft");
      if (left) {
        // group_left(<labels>) copies labels from the one side; only the bare form is supported.
        const after = left.nextSibling;
        if (after && after.name === "GroupingLabels" && after !== grouping) throw new Error("rule-eval: group_left with labels is not supported");
        groupLeft = true;
      }
    }
    const lhs = this.node(lhsNode, src, t);
    const rhs = this.node(rhsNode, src, t);
    const signature = (labels: Labels): string => {
      const base = withoutName(labels);
      const picked: Labels = {};
      for (const [k, v] of Object.entries(base)) {
        if (on ? on.includes(k) : !ignoring.includes(k)) picked[k] = v;
      }
      return key(picked);
    };

    if (op === "and" || op === "or" || op === "unless") {
      if (lhs.kind !== "vector" || rhs.kind !== "vector") throw new Error(`rule-eval: ${op} takes two vectors`);
      const rhsSigs = new Set(rhs.elements.map((e) => signature(e.labels)));
      if (op === "and") return { kind: "vector", elements: lhs.elements.filter((e) => rhsSigs.has(signature(e.labels))) };
      if (op === "unless") return { kind: "vector", elements: lhs.elements.filter((e) => !rhsSigs.has(signature(e.labels))) };
      const lhsSigs = new Set(lhs.elements.map((e) => signature(e.labels)));
      return { kind: "vector", elements: [...lhs.elements, ...rhs.elements.filter((e) => !lhsSigs.has(signature(e.labels)))] };
    }

    const comparison = [">", "<", ">=", "<=", "==", "!="].includes(op);
    const apply = (a: number, b: number): number | undefined => {
      switch (op) {
        case "+":
          return a + b;
        case "-":
          return a - b;
        case "*":
          return a * b;
        case "/":
          return a / b;
        case ">":
          return a > b ? a : undefined;
        case "<":
          return a < b ? a : undefined;
        case ">=":
          return a >= b ? a : undefined;
        case "<=":
          return a <= b ? a : undefined;
        case "==":
          return a === b ? a : undefined;
        case "!=":
          return a !== b ? a : undefined;
        default:
          throw new Error(`rule-eval: operator ${op} is not supported`);
      }
    };

    if (lhs.kind === "scalar" && rhs.kind === "scalar") {
      if (comparison) throw new Error("rule-eval: scalar comparison needs bool");
      return { kind: "scalar", value: apply(lhs.value, rhs.value)! };
    }
    const keepName = comparison;
    if (lhs.kind === "vector" && rhs.kind === "scalar") {
      const elements: VectorElement[] = [];
      for (const e of lhs.elements) {
        const v = apply(e.value, rhs.value);
        if (v !== undefined) elements.push({ labels: keepName ? e.labels : withoutName(e.labels), value: v });
      }
      return { kind: "vector", elements };
    }
    if (lhs.kind === "scalar" && rhs.kind === "vector") {
      const elements: VectorElement[] = [];
      for (const e of rhs.elements) {
        const v = apply(lhs.value, e.value);
        // A scalar-vector comparison filters the vector and keeps its sample value.
        if (v !== undefined) elements.push({ labels: keepName ? e.labels : withoutName(e.labels), value: comparison ? e.value : v });
      }
      return { kind: "vector", elements };
    }
    const l = lhs as { elements: VectorElement[] };
    const r = rhs as { elements: VectorElement[] };
    const bySig = new Map<string, VectorElement>();
    for (const e of r.elements) {
      const s = signature(e.labels);
      if (bySig.has(s)) throw new Error("rule-eval: many-to-many matching is not supported");
      bySig.set(s, e);
    }
    if (!groupLeft) {
      const seen = new Set<string>();
      for (const e of l.elements) {
        const s = signature(e.labels);
        if (seen.has(s)) throw new Error("rule-eval: many-to-one matching needs group_left");
        seen.add(s);
      }
    }
    const elements: VectorElement[] = [];
    for (const e of l.elements) {
      const other = bySig.get(signature(e.labels));
      if (!other) continue;
      const v = apply(e.value, other.value);
      if (v === undefined) continue;
      const labels = on && !keepName ? pick(withoutName(e.labels), on) : keepName ? e.labels : withoutName(e.labels);
      elements.push({ labels, value: v });
    }
    return { kind: "vector", elements };
  }
}

function pick(labels: Labels, names: string[]): Labels {
  const out: Labels = {};
  for (const n of names) if (labels[n] !== undefined) out[n] = labels[n];
  return out;
}
