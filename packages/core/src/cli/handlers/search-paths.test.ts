import { describe, test, expect, vi } from "vitest";
import { __searchInternals, resolveKindTerms } from "./search";

// #4359: transitive edges, attribute-qualified edges, and the path a match was reached by.
const { parseQuery, matchTerm, findPath, formatPath, searchJson, explain, describeTerm } = __searchInternals;

function node(id: string, kind: string, attrs: Record<string, unknown> = {}) {
  return { id, kind, lexicon: "terraform", attrs } as never;
}

type G = { nodes: { id: string }[]; edges: unknown[] };

function run(ir: G, query: string): string[] {
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));
  const terms = parseQuery(query);
  // As runSearch does: `kind:aws_vpc` means aws_vpc, not aws_vpc_ipam_pool.
  resolveKindTerms(terms, ir.nodes as never);
  return ir.nodes
    .filter((n) => terms.every((t) => matchTerm(n as never, t, ir as never, byId as never)))
    .map((n) => n.id);
}

// Four resources linked by references, the way the terraform lexicon records
// them: each edge points from the consumer to the producer, with the
// consumer's attribute (viaAttr) and the producer's (toAttr).
const chain: G = {
  nodes: [
    node("aws_instance.web", "aws_instance"),
    node("aws_subnet.a", "aws_subnet"),
    node("aws_vpc.main", "aws_vpc"),
    node("aws_vpc_ipam_pool.p", "aws_vpc_ipam_pool"),
  ],
  edges: [
    { from: "aws_instance.web", to: "aws_subnet.a", kind: "ref", viaAttr: "subnet_id", toAttr: "id" },
    { from: "aws_subnet.a", to: "aws_vpc.main", kind: "ref", viaAttr: "vpc_id", toAttr: "id" },
    { from: "aws_vpc.main", to: "aws_vpc_ipam_pool.p", kind: "ref", viaAttr: "ipv4_ipam_pool_id", toAttr: "id" },
  ],
};

describe("edge term grammar", () => {
  test("depth: * is one or more hops, {n} exactly n, {m,n} a range, {m,} open", () => {
    expect(parseQuery("->*kind:aws_vpc")).toEqual([
      { kind: "edge", a: "", dir: "out", depth: { min: 1, max: Infinity }, sub: { kind: "kind", a: "aws_vpc" } },
    ]);
    expect(parseQuery("<-{1,3}kind:aws_instance")[0]).toMatchObject({ dir: "in", depth: { min: 1, max: 3 } });
    expect(parseQuery("<-{2}kind:aws_instance")[0]).toMatchObject({ depth: { min: 2, max: 2 } });
    expect(parseQuery("<-{2,}kind:aws_instance")[0]).toMatchObject({ depth: { min: 2, max: Infinity } });
  });

  test("attribute qualifiers, with or without a target", () => {
    expect(parseQuery("<-[via=vpc_id]kind:aws_subnet")).toEqual([
      { kind: "edge", a: "", dir: "in", viaAttr: "vpc_id", sub: { kind: "kind", a: "aws_subnet" } },
    ]);
    expect(parseQuery("->*[via=subnet_id,to=id]")).toEqual([
      { kind: "edge", a: "", dir: "out", depth: { min: 1, max: Infinity }, viaAttr: "subnet_id", toAttr: "id" },
    ]);
    expect(parseQuery("!->[to=arn]")[0]).toMatchObject({ negated: true, toAttr: "arn" });
  });

  test("a plain one-hop term parses exactly as before: no depth, no qualifier", () => {
    expect(parseQuery("->kind:Subnet")).toEqual([{ kind: "edge", a: "", dir: "out", sub: { kind: "kind", a: "Subnet" } }]);
    expect(Object.keys(parseQuery("<-kind:Instance")[0]).sort()).toEqual(["a", "dir", "kind", "sub"]);
  });

  test("what the grammar cannot read is refused with the correction", () => {
    expect(() => parseQuery("->*")).toThrow(/needs a target/);
    expect(() => parseQuery("!<-{1,2}")).toThrow(/needs a target/);
    expect(() => parseQuery("->{0}kind:X")).toThrow(/depth/);
    expect(() => parseQuery("->{3,1}kind:X")).toThrow(/depth/);
    expect(() => parseQuery("->{a}kind:X")).toThrow(/depth/);
    expect(() => parseQuery("->[from=x]kind:X")).toThrow(/qualifier/);
    expect(() => parseQuery("->[via=x")).toThrow(/qualifier/);
  });

  test("describeTerm writes the operator back as the query spelled it", () => {
    expect(describeTerm(parseQuery("->*kind:aws_vpc")[0] as never)).toBe("→*kind:aws_vpc (no such edge)");
    expect(describeTerm(parseQuery("<-{1,3}[via=vpc_id]kind:aws_subnet")[0] as never)).toBe(
      "←{1,3}[via=vpc_id]kind:aws_subnet (no such edge)",
    );
    expect(describeTerm(parseQuery("!->{2,}[to=id]")[0] as never)).toBe("!→{2,}[to=id] (no such edge)");
  });
});

describe("transitive edges on a four-resource chain", () => {
  test("a transitive term matches every node at any depth", () => {
    expect(run(chain, "->*kind:aws_vpc_ipam_pool")).toEqual(["aws_instance.web", "aws_subnet.a", "aws_vpc.main"]);
    expect(run(chain, "<-*kind:aws_instance")).toEqual(["aws_subnet.a", "aws_vpc.main", "aws_vpc_ipam_pool.p"]);
  });

  test("a bounded term matches only within its limit", () => {
    expect(run(chain, "->{1,2}kind:aws_vpc_ipam_pool")).toEqual(["aws_subnet.a", "aws_vpc.main"]);
    expect(run(chain, "->{3}kind:aws_vpc_ipam_pool")).toEqual(["aws_instance.web"]);
    expect(run(chain, "->{2,}kind:aws_vpc_ipam_pool")).toEqual(["aws_instance.web", "aws_subnet.a"]);
    expect(run(chain, "<-{1,2}kind:aws_instance")).toEqual(["aws_subnet.a", "aws_vpc.main"]);
  });

  test("one hop still means one hop", () => {
    expect(run(chain, "->kind:aws_vpc_ipam_pool")).toEqual(["aws_vpc.main"]);
    expect(run(chain, "!<-kind:aws_subnet kind:aws_vpc")).toEqual([]);
  });
});

describe("attribute-qualified edges", () => {
  test("[via=] matches only edges whose viaAttr is the given name", () => {
    expect(run(chain, "<-[via=vpc_id]")).toEqual(["aws_vpc.main"]);
    expect(run(chain, "->[via=vpc_id]kind:aws_vpc")).toEqual(["aws_subnet.a"]);
    expect(run(chain, "->[via=subnet_id]kind:aws_vpc")).toEqual([]);
  });

  test("[to=] matches only edges whose toAttr is the given name", () => {
    expect(run(chain, "->[to=id]")).toEqual(["aws_instance.web", "aws_subnet.a", "aws_vpc.main"]);
    expect(run(chain, "->[to=arn]")).toEqual([]);
  });

  test("a qualifier holds for every edge on a transitive path", () => {
    // web reaches the VPC through subnet_id then vpc_id, so no single name covers the path.
    expect(run(chain, "->*[via=subnet_id]kind:aws_vpc")).toEqual([]);
    expect(run(chain, "->*[to=id]kind:aws_vpc")).toEqual(["aws_instance.web", "aws_subnet.a"]);
  });

  test("an edge with no recorded attribute never satisfies a qualifier", () => {
    const g: G = {
      nodes: [node("x", "aws_instance"), node("y", "aws_subnet")],
      edges: [{ from: "x", to: "y", kind: "ref" }],
    };
    expect(run(g, "->kind:aws_subnet")).toEqual(["x"]);
    expect(run(g, "->[via=subnet_id]kind:aws_subnet")).toEqual([]);
  });
});

describe("cycles", () => {
  // a -> b -> c -> a, plus c -> d
  const cyc: G = {
    nodes: [node("a", "T::A"), node("b", "T::B"), node("c", "T::C"), node("d", "T::D")],
    edges: [
      { from: "a", to: "b", kind: "ref", viaAttr: "next" },
      { from: "b", to: "c", kind: "ref", viaAttr: "next" },
      { from: "c", to: "a", kind: "ref", viaAttr: "next" },
      { from: "c", to: "d", kind: "ref", viaAttr: "sink" },
    ],
  };

  test("a cycle does not hang the matcher, and a miss is a clean miss", () => {
    expect(run(cyc, "->*kind:Nothing")).toEqual([]);
    expect(run(cyc, "<-*kind:Nothing")).toEqual([]);
    expect(run(cyc, "->{50,}kind:Nothing")).toEqual([]);
  });

  test("a walk round the cycle still finds what it should", () => {
    // Every node of the cycle reaches d, and reaches itself.
    expect(run(cyc, "->*kind:T::D")).toEqual(["a", "b", "c"]);
    expect(run(cyc, "->*kind:T::A")).toEqual(["a", "b", "c"]);
    // A depth past the cycle's length is reached by going round again.
    expect(run(cyc, "->{4}kind:T::B")).toEqual(["a"]);
    expect(run(cyc, "->{7,}kind:T::B")).toEqual(["a", "b", "c"]);
  });
});

describe("the path each match was reached by", () => {
  const byId = new Map(chain.nodes.map((n) => [n.id, n]));

  test("findPath returns the hops in walk order, each in the edge's own direction", () => {
    const [t] = parseQuery("->*kind:aws_vpc_ipam_pool");
    const hops = findPath(chain.nodes[0] as never, t, chain as never, byId as never);
    expect(hops).toEqual([
      { from: "aws_instance.web", fromAttr: "subnet_id", to: "aws_subnet.a", toAttr: "id" },
      { from: "aws_subnet.a", fromAttr: "vpc_id", to: "aws_vpc.main", toAttr: "id" },
      { from: "aws_vpc.main", fromAttr: "ipv4_ipam_pool_id", to: "aws_vpc_ipam_pool.p", toAttr: "id" },
    ]);
    expect(formatPath(hops!, "out")).toBe(
      "aws_instance.web.subnet_id -> aws_subnet.a.id; aws_subnet.a.vpc_id -> aws_vpc.main.id; aws_vpc.main.ipv4_ipam_pool_id -> aws_vpc_ipam_pool.p.id",
    );
  });

  test("walking <- reads producer to consumer", () => {
    const [t] = parseQuery("<-*kind:aws_instance");
    const hops = findPath(chain.nodes[2] as never, t, chain as never, byId as never);
    expect(formatPath(hops!, "in")).toBe("aws_vpc.main.id <- aws_subnet.a.vpc_id; aws_subnet.a.id <- aws_instance.web.subnet_id");
  });

  test("the path is the shortest one", () => {
    const g: G = {
      nodes: [node("x", "A"), node("y", "B"), node("z", "C")],
      edges: [
        { from: "x", to: "y", kind: "ref", viaAttr: "long" },
        { from: "y", to: "z", kind: "ref", viaAttr: "long" },
        { from: "x", to: "z", kind: "ref", viaAttr: "short" },
      ],
    };
    const [t] = parseQuery("->*kind:C");
    const hops = findPath(g.nodes[0] as never, t, g as never, new Map(g.nodes.map((n) => [n.id, n])) as never);
    expect(hops).toEqual([{ from: "x", fromAttr: "short", to: "z" }]);
  });

  test("--explain prints one path line per match and edge term", () => {
    const query = "kind:aws_instance ->*kind:aws_vpc_ipam_pool";
    const terms = parseQuery(query);
    const matches = [chain.nodes[0]];
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((s: string) => { lines.push(s); });
    explain(terms as never, matches as never, chain as never, byId as never, query);
    spy.mockRestore();
    expect(lines[0]).toContain("1 of 1 aws_instance matched");
    expect(lines).toContain(
      "  path aws_instance.web.subnet_id -> aws_subnet.a.id; aws_subnet.a.vpc_id -> aws_vpc.main.id; aws_vpc.main.ipv4_ipam_pool_id -> aws_vpc_ipam_pool.p.id",
    );
  });

  test("--json carries the path as a list of hops per edge term", () => {
    const query = "->{1,2}[to=id]kind:aws_vpc_ipam_pool !<-kind:aws_instance";
    const terms = parseQuery(query);
    const matches = [chain.nodes[2]];
    const out = searchJson(query, { kind: "declared" }, matches as never, terms, chain as never, byId as never);
    expect(out).toEqual({
      query,
      source: { kind: "declared" },
      matches: [
        {
          id: "aws_vpc.main",
          displayId: "aws_vpc.main",
          kind: "aws_vpc",
          paths: [
            {
              term: "->{1,2}[to=id]kind:aws_vpc_ipam_pool",
              dir: "out",
              hops: [{ from: "aws_vpc.main", fromAttr: "ipv4_ipam_pool_id", to: "aws_vpc_ipam_pool.p", toAttr: "id" }],
            },
          ],
        },
      ],
    });
    // A query with no edge term carries an empty path list.
    expect(searchJson("kind:aws_vpc", { kind: "declared" }, matches as never, parseQuery("kind:aws_vpc"), chain as never, byId as never).matches[0].paths).toEqual([]);
  });
});
