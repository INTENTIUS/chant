/**
 * The matcher for capability rules (#4375): evaluates `./language.ts` rules
 * over a `./view.ts` view, lazily, keeping the path that proved each fact.
 *
 * A capability is computed the first time something asks for it, over the
 * whole view, and kept. One that refers to another asks for it first, so
 * negation is stratified by construction: `[!@cap]` reads a set that is
 * already complete. Two capabilities that need each other are refused.
 */
import type { Alternative, Literal, NodeSpec, Rule, Step, Test, Value } from "./language";
import type { View, ViewHop } from "./view";

/** Why a node is in a set, or a pair in an edge: the hops walked, and the sets it relied on. */
export interface Evidence {
  /** IR hops in walk order. Each keeps the edge's own direction. */
  hops: ViewHop[];
  /** The `[@cap]` tests the match relied on, each with its own evidence. */
  because: { capability: string; id: string; evidence: Evidence }[];
}

export type Args = Record<string, Literal | undefined>;

/** An edge capability: each source's targets, with evidence. */
export interface Relation {
  out: Map<string, Map<string, Evidence>>;
  in: Map<string, Map<string, Evidence>>;
}

export class CapabilityError extends Error {}

const glob = (pattern: string, s: string): boolean =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i").test(s);

function equal(a: unknown, b: Literal): boolean {
  if (b === null) return a === null || a === undefined;
  if (a === b) return true;
  if (a === null || a === undefined || typeof a === "object") return false;
  return String(a) === String(b);
}

function present(a: unknown): boolean {
  return a !== undefined && a !== null && a !== false && !(Array.isArray(a) && a.length === 0);
}

const reverseHops = (hops: ViewHop[]): ViewHop[] => [...hops].reverse();

export class CapabilityEngine {
  private readonly rules = new Map<string, Rule>();
  private readonly sets = new Map<string, Map<string, Evidence>>();
  private readonly relations = new Map<string, Relation>();
  private readonly busy = new Set<string>();
  private readonly out = new Map<string, Map<string, { to: string; hops: ViewHop[] }[]>>();
  private readonly in = new Map<string, Map<string, { to: string; hops: ViewHop[] }[]>>();
  private readonly byLabel = new Map<string, string[]>();

  constructor(
    readonly view: View,
    rules: Rule[],
  ) {
    for (const r of rules) this.rules.set(r.name, r);
    for (const e of view.edges) {
      this.index(this.out, e.from, e.name, e.to, e.hops);
      this.index(this.in, e.to, e.name, e.from, reverseHops(e.hops));
    }
    for (const n of view.nodes.values()) {
      if (!this.byLabel.has(n.label)) this.byLabel.set(n.label, []);
      this.byLabel.get(n.label)!.push(n.id);
    }
    for (const r of rules) this.check(r);
  }

  private index(ix: CapabilityEngine["out"], a: string, name: string, b: string, hops: ViewHop[]): void {
    let m = ix.get(a);
    if (!m) ix.set(a, (m = new Map()));
    let l = m.get(name);
    if (!l) m.set(name, (l = []));
    l.push({ to: b, hops });
  }

  /** Refuse a rule that names a capability that doesn't exist, or uses one in the wrong shape. */
  private check(r: Rule): void {
    const node = (n: NodeSpec, alt: Alternative): void => {
      for (const t of n.tests) {
        if (t.kind !== "cap") continue;
        const target = this.rules.get(t.cap);
        if (!target) throw new CapabilityError(`${r.name} (line ${alt.line}): no capability "${t.cap}"`);
        if (target.vars.length !== 1) throw new CapabilityError(`${r.name} (line ${alt.line}): "@${t.cap}" is an edge, not a set; follow it with ->${t.cap}`);
      }
    };
    for (const alt of r.alts) {
      node(alt.head, alt);
      for (const s of alt.steps) {
        node(s.node, alt);
        for (const n of s.names) {
          const target = this.rules.get(n.name);
          if (target && target.vars.length !== 2) {
            throw new CapabilityError(`${r.name} (line ${alt.line}): "${n.name}" is a set, not an edge; test it with [@${n.name}]`);
          }
        }
      }
    }
  }

  has(name: string): boolean {
    return this.rules.has(name);
  }

  /** The capabilities the catalog lists: rules that carry a `## meaning`. */
  publicNames(): string[] {
    return [...this.rules.values()].filter((r) => r.meta.meaning !== undefined).map((r) => r.name);
  }

  rule(name: string): Rule | undefined {
    return this.rules.get(name);
  }

  /** Bind positional arguments to a rule's parameters. */
  bind(name: string, positional: (Literal | undefined)[]): Args {
    const r = this.rules.get(name);
    if (!r) throw new CapabilityError(`no capability "${name}"`);
    if (positional.length > r.params.length) {
      throw new CapabilityError(`${name} takes ${r.params.length === 0 ? "no arguments" : `at most ${r.params.length} (${r.params.map((p) => p.name).join(", ")})`}`);
    }
    const args: Args = {};
    r.params.forEach((p, i) => {
      const v = positional[i];
      if (v === undefined && !p.optional) throw new CapabilityError(`${name} needs ${p.name}`);
      args[p.name] = v;
    });
    return args;
  }

  private key(name: string, args: Args): string {
    return `${name}(${JSON.stringify(Object.entries(args).filter(([, v]) => v !== undefined).sort())})`;
  }

  /** The nodes in a set capability, with evidence. */
  set(name: string, args: Args = {}): Map<string, Evidence> {
    const r = this.rules.get(name);
    if (!r) throw new CapabilityError(`no capability "${name}"`);
    if (r.vars.length !== 1) throw new CapabilityError(`"${name}" is an edge, not a set`);
    const key = this.key(name, args);
    const cached = this.sets.get(key);
    if (cached) return cached;
    this.enter(key);
    const out = new Map<string, Evidence>();
    for (const alt of r.alts) {
      for (const s of this.starts(alt.head)) {
        this.match(alt, s, args, (env, ev) => {
          const x = env[r.vars[0]] ?? s;
          if (!out.has(x)) out.set(x, ev);
        });
      }
    }
    this.busy.delete(key);
    this.sets.set(key, out);
    return out;
  }

  /** The pairs in an edge capability, with evidence. */
  relation(name: string, args: Args = {}): Relation {
    const r = this.rules.get(name);
    if (!r) throw new CapabilityError(`no capability "${name}"`);
    if (r.vars.length !== 2) throw new CapabilityError(`"${name}" is a set, not an edge`);
    const key = this.key(name, args);
    const cached = this.relations.get(key);
    if (cached) return cached;
    this.enter(key);
    const rel: Relation = { out: new Map(), in: new Map() };
    for (const alt of r.alts) {
      for (const s of this.starts(alt.head)) {
        this.match(alt, s, args, (env, ev, last) => {
          const a = env[r.vars[0]] ?? s;
          const b = env[r.vars[1]] ?? last;
          if (a === b) return;
          let m = rel.out.get(a);
          if (!m) rel.out.set(a, (m = new Map()));
          if (m.has(b)) return;
          m.set(b, ev);
          let back = rel.in.get(b);
          if (!back) rel.in.set(b, (back = new Map()));
          back.set(a, ev);
        });
      }
    }
    this.busy.delete(key);
    this.relations.set(key, rel);
    return rel;
  }

  private enter(key: string): void {
    if (this.busy.has(key)) {
      throw new CapabilityError(`capability ${key} refers to itself through ${[...this.busy].join(" -> ")}`);
    }
    this.busy.add(key);
  }

  private starts(head: NodeSpec): string[] {
    if (!head.labels) return [...this.view.nodes.keys()];
    return head.labels.flatMap((l) => this.byLabel.get(l) ?? []);
  }

  private resolve(v: Value, args: Args): Literal | undefined {
    return "lit" in v ? v.lit : args[v.param];
  }

  private test(id: string, t: Test, args: Args, because: Evidence["because"]): boolean {
    const result = ((): boolean => {
      if (t.kind === "cap") {
        const capArgs = this.bind(t.cap, t.args.map((v) => this.resolve(v, args)));
        const ev = this.set(t.cap, capArgs).get(id);
        if (ev && !t.negated) because.push({ capability: t.cap, id, evidence: ev });
        return !!ev;
      }
      const n = this.view.nodes.get(id)!;
      const a = n.attrs[t.attr];
      if (t.op === "present") return present(a);
      const values = t.values.map((v) => this.resolve(v, args));
      // A test on a parameter nobody passed is left out, whatever else it names.
      if (values.some((v) => v === undefined)) return !t.negated;
      const given = values as Literal[];
      const each = Array.isArray(a) ? a : [a];
      switch (t.op) {
        case "=":
        case "in":
          return each.some((x) => given.some((v) => equal(x, v)));
        case "!=":
          return !each.some((x) => equal(x, given[0]));
        case "~":
          return each.some((x) => typeof x === "string" && given.some((v) => typeof v === "string" && (glob(x, v) || glob(v, x))));
        default: {
          const v = Number(given[0]);
          return each.some((x) => {
            const nx = Number(x);
            if (x === null || x === undefined || Number.isNaN(nx) || Number.isNaN(v)) return false;
            return t.op === "<" ? nx < v : t.op === "<=" ? nx <= v : t.op === ">" ? nx > v : nx >= v;
          });
        }
      }
    })();
    return t.negated ? !result : result;
  }

  private ok(id: string, s: NodeSpec, env: Record<string, string>, args: Args, because: Evidence["because"]): boolean {
    if (s.v && env[s.v] !== undefined && env[s.v] !== id) return false;
    const n = this.view.nodes.get(id);
    if (!n) return false;
    if (s.labels && !s.labels.includes(n.label)) return false;
    return s.tests.every((t) => this.test(id, t, args, because));
  }

  private hop(id: string, step: Step, args: Args): { to: string; hops: ViewHop[] }[] {
    const out: { to: string; hops: ViewHop[] }[] = [];
    for (const n of step.names) {
      if (this.rules.has(n.name)) {
        const rel = this.relation(n.name, this.bind(n.name, n.args.map((v) => this.resolve(v, args))));
        const m = (step.dir === "out" ? rel.out : rel.in).get(id);
        if (m) for (const [to, ev] of m) out.push({ to, hops: step.dir === "out" ? ev.hops : reverseHops(ev.hops) });
      } else {
        out.push(...((step.dir === "out" ? this.out : this.in).get(id)?.get(n.name) ?? []));
      }
    }
    return out;
  }

  /** Every node within the step's depth range, by its shortest walk. */
  private walk(id: string, step: Step, args: Args): { to: string; hops: ViewHop[] }[] {
    const res: { to: string; hops: ViewHop[] }[] = [];
    const seen = new Set([id]);
    let frontier = [{ to: id, hops: [] as ViewHop[] }];
    if (step.min === 0) res.push(frontier[0]);
    for (let d = 1; d <= step.max && frontier.length > 0; d++) {
      const next: typeof frontier = [];
      for (const f of frontier) {
        for (const h of this.hop(f.to, step, args)) {
          if (step.max > 1) {
            if (seen.has(h.to)) continue;
            seen.add(h.to);
          }
          const p = { to: h.to, hops: [...f.hops, ...h.hops] };
          next.push(p);
          if (d >= step.min) res.push(p);
        }
      }
      frontier = next;
    }
    return res;
  }

  private match(
    alt: Alternative,
    start: string,
    args: Args,
    emit: (env: Record<string, string>, ev: Evidence, last: string) => void,
  ): void {
    const because0: Evidence["because"] = [];
    if (!this.ok(start, alt.head, {}, args, because0)) return;
    const env0: Record<string, string> = alt.head.v ? { [alt.head.v]: start } : {};
    const go = (k: number, at: string, env: Record<string, string>, hops: ViewHop[], because: Evidence["because"]): void => {
      if (k === alt.steps.length) return emit(env, { hops, because }, at);
      const st = alt.steps[k];
      if (st.negated) {
        const blocked = this.walk(at, st, args).some((w) => this.ok(w.to, st.node, env, args, []));
        if (!blocked) go(k + 1, at, env, hops, because);
        return;
      }
      for (const w of this.walk(at, st, args)) {
        const b: Evidence["because"] = [];
        if (!this.ok(w.to, st.node, env, args, b)) continue;
        go(k + 1, w.to, st.node.v ? { ...env, [st.node.v]: w.to } : env, [...hops, ...w.hops], [...because, ...b]);
      }
    };
    go(0, start, env0, [], because0);
  }
}
