/**
 * The capability rule language and its matcher (#4375), over hand-built
 * views: what each construct means, independent of any lexicon.
 */
import { describe, expect, it } from "vitest";
import { parseRules, RuleSyntaxError } from "./language";
import { CapabilityEngine, CapabilityError } from "./matcher";
import { isPublic, lexiconSupport, parseCapabilityCall, shippedRules } from "./catalog";
import type { View, ViewNode } from "./view";

function view(nodes: [string, string, Record<string, unknown>?][], edges: [string, string, string][]): View {
  const ns = new Map<string, ViewNode>(
    nodes.map(([id, label, attrs]) => [id, { id, label, irId: id, lexicon: "test", attrs: attrs ?? {} }]),
  );
  return {
    nodes: ns,
    edges: edges.map(([from, name, to]) => ({ from, to, name, hops: [{ from, to, edge: name }] })),
    lexicons: new Set(["test"]),
  };
}

const keys = (m: Map<string, unknown>) => [...m.keys()].sort();
const pairs = (rel: { out: Map<string, Map<string, unknown>> }) =>
  [...rel.out].flatMap(([a, m]) => [...m.keys()].map((b) => `${a}>${b}`)).sort();

describe("parseRules", () => {
  it("reads sets, edges, parameters, alternatives, continuation lines and metadata", () => {
    const rules = parseRules(`
# a comment
## meaning: a thing
## answers: one
## answers: two
thing(x) := x:A|B[size >= 2, !gone]
          | x:C
link(a, b; p?, q) := a ->{0,1}via ->(e|f) b:B[n = $p] !<-blocked
long(x) :=
    x:A
`);
    expect(rules.map((r) => [r.name, r.vars, r.params, r.alts.length])).toEqual([
      ["thing", ["x"], [], 2],
      ["link", ["a", "b"], [{ name: "p", optional: true }, { name: "q", optional: false }], 1],
      ["long", ["x"], [], 1],
    ]);
    expect(rules[0].meta).toEqual({ meaning: "a thing", answers: "one\ntwo" });
    expect(rules[0].text).toBe("thing(x) := x:A|B[size >= 2, !gone]\n| x:C");
    const steps = rules[1].alts[0].steps;
    expect(steps.map((s) => [s.dir, s.negated, s.names.map((n) => n.name), s.min, s.max])).toEqual([
      ["out", false, ["via"], 0, 1],
      ["out", false, ["e", "f"], 1, 1],
      ["in", true, ["blocked"], 1, 1],
    ]);
  });

  it("refuses what it can't read, naming the line", () => {
    expect(() => parseRules("a(x) := x:A\nb(x) := x[n ?? 1]")).toThrow(RuleSyntaxError);
    expect(() => parseRules("a(x) := x:A\nb(x) := x[n ?? 1]")).toThrow(/line 2/);
    expect(() => parseRules("| x:A")).toThrow(/needs a rule above it/);
    expect(() => parseRules("a(x) := x:A\na(x) := x:B")).toThrow(/defined twice/);
    expect(() => parseRules("a(x) := x !->{0,2}e")).toThrow(/negated step takes no depth/);
  });

  it("reads a capability call as search spells it", () => {
    expect(parseCapabilityCall("open-ingress(22, tcp)")).toEqual({ name: "open-ingress", args: [22, "tcp"] });
    expect(parseCapabilityCall("grants(s3:GetObject)")).toEqual({ name: "grants", args: ["s3:GetObject"] });
    expect(parseCapabilityCall("reaches")).toEqual({ name: "reaches", args: [] });
    expect(parseCapabilityCall("bad name")).toBeUndefined();
  });
});

describe("the matcher", () => {
  const v = view(
    [
      ["a", "A", { size: 3 }],
      ["b", "A", { size: 1 }],
      ["c", "B", { tags: ["x", "y"] }],
      ["d", "B"],
      ["e", "B"],
    ],
    [
      ["a", "to", "c"],
      ["c", "to", "d"],
      ["d", "to", "e"],
      ["b", "to", "d"],
      ["e", "blocks", "d"],
    ],
  );

  it("tests attributes, lists and labels", () => {
    const e = new CapabilityEngine(v, parseRules(`
big(x) := x:A[size >= 2]
tagged(x) := x[tags in ("y")]
absent(x) := x:B[!tags]
`));
    expect(keys(e.set("big"))).toEqual(["a"]);
    expect(keys(e.set("tagged"))).toEqual(["c"]);
    expect(keys(e.set("absent"))).toEqual(["d", "e"]);
  });

  it("walks a depth range, keeping the hops it took", () => {
    const e = new CapabilityEngine(v, parseRules(`
near(a, b) := a:A ->to b
far(a, b) := a:A ->{2,} to b
`));
    expect(pairs(e.relation("near"))).toEqual(["a>c", "b>d"]);
    expect(pairs(e.relation("far"))).toEqual(["a>d", "a>e", "b>e"]);
    expect(e.relation("far").out.get("a")!.get("e")!.hops.map((h) => `${h.from}${h.to}`)).toEqual(["ac", "cd", "de"]);
  });

  it("negates a step and a capability test, and reads a capability that uses another", () => {
    const e = new CapabilityEngine(v, parseRules(`
unblocked(x) := x:B !<-blocks
big(x) := x:A[size >= 2]
small-reach(a, b) := a:A[!@big] ->{1,} to b[@unblocked]
`));
    expect(keys(e.set("unblocked"))).toEqual(["c", "e"]);
    expect(pairs(e.relation("small-reach"))).toEqual(["b>e"]);
  });

  it("leaves out a test on a parameter nobody passed, and applies it when one is", () => {
    const e = new CapabilityEngine(v, parseRules(`sized(x; min?) := x:A[size >= $min]`));
    expect(keys(e.set("sized"))).toEqual(["a", "b"]);
    expect(keys(e.set("sized", e.bind("sized", [2])))).toEqual(["a"]);
    expect(() => e.bind("sized", [1, 2])).toThrow(/at most 1/);
  });

  it("closes a pattern on a variable it bound earlier", () => {
    const loop = view([["p", "A"], ["q", "A"], ["r", "A"]], [["p", "to", "q"], ["q", "back", "p"], ["q", "back", "r"]]);
    const e = new CapabilityEngine(loop, parseRules(`mutual(a, b) := a ->to b ->back a`));
    expect(pairs(e.relation("mutual"))).toEqual(["p>q"]);
  });

  it("carries the evidence of each set a match relied on", () => {
    const e = new CapabilityEngine(v, parseRules(`
big(x) := x:A[size >= 2]
from-big(a, b) := a[@big] ->to b
`));
    const ev = e.relation("from-big").out.get("a")!.get("c")!;
    expect(ev.because.map((b) => [b.capability, b.id])).toEqual([["big", "a"]]);
  });

  it("refuses a capability that needs itself, an unknown one, and one used in the wrong shape", () => {
    expect(() => new CapabilityEngine(v, parseRules(`a(x) := x[@nope]`))).toThrow(/no capability "nope"/);
    expect(() => new CapabilityEngine(v, parseRules(`e(a, b) := a ->to b\ns(x) := x[@e]`))).toThrow(/is an edge, not a set/);
    const self = new CapabilityEngine(v, parseRules(`loop(x) := x[@loop]`));
    expect(() => self.set("loop")).toThrow(CapabilityError);
  });
});

describe("the shipped catalog", () => {
  const { rules } = shippedRules();
  const pub = rules.filter(isPublic);

  it("lists the 15 capabilities of the #4361 ruling (grants and reaches are one row)", () => {
    expect(pub.map((r) => r.name)).toEqual([
      "internet-facing",
      "open-ingress",
      "internet-reachable",
      "attached-to-nothing",
      "in-default-vpc",
      "network",
      "stores-data",
      "holds-secret",
      "encrypted-at-rest",
      "publicly-readable",
      "runs-as",
      "can-assume",
      "grants",
      "reaches",
      "exfiltrates",
      "blast",
    ]);
  });

  it("gives each a meaning, at least one answer and a depth", () => {
    for (const r of pub) {
      expect(r.meta.meaning, r.name).toBeTruthy();
      expect(r.meta.answers, r.name).toBeTruthy();
      expect(["declared", "live", "either"], r.name).toContain(r.meta.depth);
      for (const p of r.params) expect(r.meta[`param-${p.name}`], `${r.name} ${p.name}`).toBeTruthy();
    }
  });

  it("says a lexicon with no mapping can't supply any of them, and why a thin mapping can't", () => {
    const rule = pub.find((r) => r.name === "grants")!;
    expect(lexiconSupport(rule, undefined, "k8s")).toEqual({ code: "lexicon-has-no-mapping", message: "the k8s lexicon ships no capability mapping" });
    const thin = lexiconSupport(rule, { lexicon: "x", labels: { "X::Bucket": "Bucket" } }, "x");
    expect(thin).toMatchObject({ code: "capability-not-derivable" });
    expect(lexiconSupport(rule, { lexicon: "x", labels: { "X::Role": "Role", "X::Policy": "Policy" } }, "x")).toBe("supported");
    expect(lexiconSupport(rule, { lexicon: "x", unsupported: { grants: { code: "c", message: "m" } } }, "x")).toEqual({ code: "c", message: "m" });
  });
});
