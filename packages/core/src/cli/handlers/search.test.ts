import { describe, test, expect, vi } from "vitest";
import { __searchInternals } from "./search";

const { parseQuery, matchTerm, formatRow, explain, describeTerm, derivedSurface, availableAttrs, ambientHint, regionSpread } = __searchInternals;

function node(id: string, kind: string, attrs: Record<string, unknown> = {}) {
  return { id, kind, lexicon: "aws", attrs } as never;
}

describe("search query parsing", () => {
  test("splits bare words, keyed terms, and quoted phrases", () => {
    const terms = parseQuery('kind:EC2::Instance tag:Name=Public "public subnet"');
    expect(terms).toEqual([
      { kind: "kind", a: "EC2::Instance" },
      { kind: "tag", a: "Name", b: "Public" },
      { kind: "word", a: "public subnet" },
    ]);
  });
});

describe("search matching", () => {
  const inst = node("webServer", "AWS::EC2::Instance", {
    physicalId: "i-abc",
    Tags: [{ Key: "Name", Value: "Public" }],
    MapPublicIpOnLaunch: true,
  });

  test("kind: is substring on the resource kind", () => {
    expect(matchTerm(inst, { kind: "kind", a: "EC2::Instance" })).toBe(true);
    expect(matchTerm(inst, { kind: "kind", a: "SecurityGroup" })).toBe(false);
  });

  test("tag: matches Key with optional Value substring", () => {
    expect(matchTerm(inst, { kind: "tag", a: "Name", b: "Pub" })).toBe(true);
    expect(matchTerm(inst, { kind: "tag", a: "Name", b: "Private" })).toBe(false);
    expect(matchTerm(inst, { kind: "tag", a: "Owner" })).toBe(false);
  });

  test("attr: matches presence or value substring", () => {
    expect(matchTerm(inst, { kind: "attr", a: "MapPublicIpOnLaunch", b: "true" })).toBe(true);
    expect(matchTerm(inst, { kind: "attr", a: "MapPublicIpOnLaunch" })).toBe(true);
    expect(matchTerm(inst, { kind: "attr", a: "Nonexistent" })).toBe(false);
  });

  test("bare word searches id, kind, and attr values", () => {
    expect(matchTerm(inst, { kind: "word", a: "webserver" })).toBe(true);
    expect(matchTerm(inst, { kind: "word", a: "i-abc" })).toBe(true);
    expect(matchTerm(inst, { kind: "word", a: "nope" })).toBe(false);
  });
});

describe("search formatting", () => {
  test("compact row with live physical id, skipping object placeholders", () => {
    const live = node("webServer", "AWS::EC2::Instance", { physicalId: "i-abc" });
    expect(formatRow(live, [])).toBe("webServer  AWS::EC2::Instance  i-abc");
    const src = node("webServer", "AWS::EC2::Instance", { InstanceId: { $ref: "webServer.InstanceId" } });
    expect(formatRow(src, [])).toBe("webServer  AWS::EC2::Instance");
  });

  test("--show renders a named column whatever shape the value is", () => {
    // A list used to be dropped silently, so `--show effectiveIngress` — the
    // derived reachability fact — printed a blank column and read as "chant
    // does not have this". A column the caller named is a column they get.
    const n = node("web", "AWS::EC2::Instance", {
      physicalId: "i-1",
      InstanceType: "t3.micro",
      effectiveIngress: ["tcp:22:0.0.0.0/0"],
    });
    expect(formatRow(n, ["InstanceType", "effectiveIngress"])).toBe(
      'web  AWS::EC2::Instance  i-1  InstanceType=t3.micro  effectiveIngress=["tcp:22:0.0.0.0/0"]',
    );
  });

  test("--show omits a column the node does not carry", () => {
    const n = node("web", "AWS::EC2::Instance", { physicalId: "i-1" });
    expect(formatRow(n, ["VpcId"])).toBe("web  AWS::EC2::Instance  i-1");
  });
});

describe("search edge traversal", () => {
  const ir = {
    nodes: [
      node("webServer", "AWS::EC2::Instance", { physicalId: "i-1" }),
      node("privSubnet", "AWS::EC2::Subnet", { MapPublicIpOnLaunch: false }),
      node("pubSubnet", "AWS::EC2::Subnet", { MapPublicIpOnLaunch: true }),
      node("privServer", "AWS::EC2::Instance", { physicalId: "i-2" }),
    ],
    edges: [
      { from: "webServer", to: "pubSubnet", kind: "ref", viaAttr: "SubnetId" },
      { from: "privServer", to: "privSubnet", kind: "ref", viaAttr: "SubnetId" },
    ],
  } as never;

  test("->attr resolves the instance→subnet→public join", () => {
    const byId = new Map((ir as { nodes: { id: string }[] }).nodes.map((n) => [n.id, n]));
    const terms = parseQuery("kind:EC2::Instance ->attr:MapPublicIpOnLaunch=true");
    const matches = (ir as { nodes: never[] }).nodes.filter((n) =>
      terms.every((t) => matchTerm(n as never, t, ir, byId as never)),
    );
    expect(matches.map((n: { id: string }) => n.id)).toEqual(["webServer"]);
  });

  test("parses -> and <- into directional edge terms", () => {
    expect(parseQuery("->kind:Subnet")).toEqual([{ kind: "edge", a: "", dir: "out", sub: { kind: "kind", a: "Subnet" } }]);
    expect(parseQuery("<-kind:Instance")).toEqual([{ kind: "edge", a: "", dir: "in", sub: { kind: "kind", a: "Instance" } }]);
  });

  test("--explain footer: universe count + why the non-match was excluded", () => {
    const byId = new Map((ir as { nodes: { id: string }[] }).nodes.map((n) => [n.id, n]));
    const query = "kind:EC2::Instance ->attr:MapPublicIpOnLaunch=true";
    const terms = parseQuery(query);
    const matches = (ir as { nodes: never[] }).nodes.filter((n) => terms.every((t) => matchTerm(n as never, t, ir, byId as never)));
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((s: string) => { lines.push(s); });
    explain(terms as never, matches as never, ir, byId as never, query);
    spy.mockRestore();
    // 1 of 2 Instances matched (webServer public, privServer excluded).
    expect(lines[0]).toContain("1 of 2 AWS::EC2::Instance matched");
    expect(lines.join("\n")).toContain("excluded privServer");
    expect(lines.join("\n")).toContain("MapPublicIpOnLaunch=true");
  });

  test("describeTerm renders an edge term with direction and no-such-edge reason", () => {
    expect(describeTerm({ kind: "edge", a: "", dir: "out", sub: { kind: "attr", a: "MapPublicIpOnLaunch", b: "true" } } as never))
      .toBe("→attr:MapPublicIpOnLaunch=true (no such edge)");
  });
});

describe("search surfaces what the graph derived", () => {
  const insts = [
    node("webServer", "AWS::EC2::Instance", { internetFacing: true, internetFacingVia: "rtb-1 → igw-1", effectiveIngress: ["tcp:22:0.0.0.0/0"] }),
    node("privServer", "AWS::EC2::Instance", { internetFacing: false, effectiveIngress: [] }),
  ];
  const derivedIr = { nodes: insts, edges: [], groups: {}, derivedAttrs: { Instance: ["internetFacing", "effectiveIngress"] } } as never;

  function capture(fn: () => void): string {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((s: string) => { lines.push(s); });
    fn();
    spy.mockRestore();
    return lines.join("\n");
  }

  test("names derived facts the query did not use, and omits the ones it did", () => {
    const out = capture(() => derivedSurface(parseQuery("kind:EC2::Instance attr:internetFacing=true") as never, insts as never, derivedIr));
    expect(out).toContain("effectiveIngress");
    expect(out).not.toContain("internetFacing");
  });

  test("says nothing when the query already used every derived fact", () => {
    const q = "kind:EC2::Instance attr:internetFacing=true attr:effectiveIngress=tcp:22:0.0.0.0/0";
    expect(capture(() => derivedSurface(parseQuery(q) as never, insts as never, derivedIr))).toBe("");
  });

  test("says nothing for a graph with no derived facts recorded", () => {
    const plain = { nodes: insts, edges: [], groups: {} } as never;
    expect(capture(() => derivedSurface(parseQuery("kind:EC2::Instance") as never, insts as never, plain))).toBe("");
  });

  test("a miss lists the attributes the queried kind actually carries", () => {
    const out = capture(() => availableAttrs(parseQuery("kind:EC2::Instance attr:nosuchattr=1") as never, derivedIr));
    expect(out).toContain("effectiveIngress");
    expect(out).toContain("internetFacing");
    expect(out).not.toContain("nosuchattr");
  });

  test("inclusion evidence is keyed off <attr>Via provenance, not a fixed attribute name", () => {
    const byId = new Map(insts.map((n: { id: string }) => [n.id, n]));
    const q = "attr:internetFacing=true";
    const out = capture(() => explain(parseQuery(q) as never, [insts[0]] as never, derivedIr, byId as never, q));
    expect(out).toContain("webServer internetFacing via rtb-1 → igw-1");
  });
});

// #1280 — absence is a real estate question ("what does nothing reference"),
// and the grammar could only express presence.
describe("negated terms (#1280)", () => {
  const ir = {
    nodes: [
      { id: "used", kind: "AWS::EC2::SecurityGroup", lexicon: "aws", attrs: {} },
      { id: "spare", kind: "AWS::EC2::SecurityGroup", lexicon: "aws", attrs: {} },
      { id: "web", kind: "AWS::EC2::Instance", lexicon: "aws", attrs: {} },
    ],
    edges: [{ from: "web", to: "used", kind: "ref" as const, viaAttr: "SecurityGroupIds" }],
    groups: {},
  };
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));
  const match = (q: string) =>
    ir.nodes.filter((n) => parseQuery(q).every((t) => matchTerm(n, t, ir, byId))).map((n) => n.id);

  test("selects what nothing references — the complement of an edge term", () => {
    expect(match("kind:SecurityGroup !<-kind:EC2::Instance")).toEqual(["spare"]);
  });

  test("the un-negated query still selects what IS referenced", () => {
    expect(match("kind:SecurityGroup <-kind:EC2::Instance")).toEqual(["used"]);
  });

  test("negates a plain attribute term too", () => {
    const nodes = [
      { id: "a", kind: "K", lexicon: "x", attrs: { env: "prod" } },
      { id: "b", kind: "K", lexicon: "x", attrs: { env: "dev" } },
    ];
    const g = { nodes, edges: [], groups: {} };
    const m = new Map(nodes.map((n) => [n.id, n]));
    expect(
      nodes.filter((n) => parseQuery("!attr:env=prod").every((t) => matchTerm(n, t, g, m))).map((n) => n.id),
    ).toEqual(["b"]);
  });

  test("a bare edge term is refused, and the refusal names the correction", () => {
    // Accepting it as "no edge in this direction" is coherent and still the
    // wrong query for "what is unused": it counts every reference, including a
    // stack output that merely publishes a resource's id, so it omits the very
    // group the question is about. Measured — refused: 3/3 right; accepted:
    // wrong in 2 runs of 3.
    expect(() => parseQuery("kind:Foo !<-")).toThrow(/needs a target/);
    expect(() => parseQuery("kind:Foo ->")).toThrow(/needs a target/);
  });

  test("a made-up prefix is refused, and names the correction", () => {
    // An agent looking for SSH reachability wrote
    // `effectiveIngress:tcp:22:0.0.0.0/0` — right idea, right attribute, wrong
    // spelling — and this parsed as a free-text word that matched nothing. It
    // read the clean empty result as "chant does not hold this fact" and
    // rebuilt the answer by hand from security-group rows.
    expect(() => parseQuery("kind:EC2::Instance effectiveIngress:tcp:22")).toThrow(
      /there is no "effectiveIngress:" prefix/,
    );
    try {
      parseQuery("effectiveIngress:tcp:22");
    } catch (e) {
      expect((e as { hint: string }).hint).toContain("attr:effectiveIngress=tcp:22");
    }
  });

  test("still accepts a word that merely contains colons", () => {
    // `AWS::EC2::Instance` and a URL are words, not malformed terms — a real
    // prefix is one colon, not two.
    expect(parseQuery("AWS::EC2::Instance")).toEqual([{ kind: "word", a: "AWS::EC2::Instance" }]);
    expect(parseQuery("https://example.com")).toEqual([{ kind: "word", a: "https://example.com" }]);
  });

  test("an edge term WITH a target still parses", () => {
    expect(() => parseQuery("kind:Foo !<-kind:Bar")).not.toThrow();
  });

  test("--explain says the term was negated, or an exclusion reads inverted", () => {
    expect(describeTerm(parseQuery("!kind:Foo")[0])).toBe("!kind:Foo");
  });
});

// #1278/#1279 — `--ambient` changes what a LIVE read goes and looks for. On a
// replay it changes nothing: what is ambient in a recording was fixed when the
// recording was taken.
describe("the --ambient hint", () => {
  const sg = node("sg-1", "AWS::EC2::SecurityGroup");
  const kinds = ["AWS::EC2::SecurityGroup"];
  const capture = (fn: () => void): string => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((s: string) => { lines.push(s); });
    fn();
    spy.mockRestore();
    return lines.join("\n");
  };

  test("names the flag on a live read that did not use it", () => {
    expect(capture(() => ambientHint([sg] as never, kinds, false))).toContain("--ambient");
  });

  test("says nothing when the caller already asked for it", () => {
    expect(capture(() => ambientHint([sg] as never, kinds, true))).toBe("");
  });

  test("says nothing on a replay whose snapshot already holds ambient resources", () => {
    // The answer is complete. Saying the flag would add something is worse than
    // silence: an agent read "6 of 6 matched" next to this hint, went looking
    // for a seventh group, and hand-built a wrong answer from the raw graph.
    expect(capture(() => ambientHint([sg] as never, kinds, false, { recordedAmbient: true }))).toBe("");
  });

  test("on a replay without them, points at the recording rather than the query", () => {
    // `--at --ambient` cannot go and look; only a new snapshot can.
    const out = capture(() => ambientHint([sg] as never, kinds, false, { recordedAmbient: false }));
    expect(out).toContain("lifecycle snapshot");
    expect(out).not.toContain("--ambient includes those");
  });
});

// #1279 — asked to list instances "in all regions", an agent printed six
// correct ids with no region against any of them, and was judged wrong.
describe("the region spread of an answer", () => {
  const inst = (id: string, region?: string) =>
    node(id, "AWS::EC2::Instance", region ? { region } : {});
  const capture = (fn: () => void): string => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((s: string) => { lines.push(s); });
    fn();
    spy.mockRestore();
    return lines.join("\n");
  };
  const spread = (ns: unknown[], show: string[] = [], q = "kind:EC2::Instance") =>
    capture(() => regionSpread(parseQuery(q) as never, ns as never, show));

  test("names the regions when the answer spans several", () => {
    const out = spread([inst("a", "us-east-1"), inst("b", "us-west-2")]);
    expect(out).toContain("us-east-1, us-west-2");
    expect(out).toContain("2 regions");
  });

  test("says nothing when everything is in one region", () => {
    expect(spread([inst("a", "us-east-1"), inst("b", "us-east-1")])).toBe("");
  });

  test("says nothing when the caller already asked for region", () => {
    expect(spread([inst("a", "us-east-1"), inst("b", "us-west-2")], ["region"])).toBe("");
    expect(spread([inst("a", "us-east-1"), inst("b", "us-west-2")], [], "attr:region=us-east-1")).toBe("");
  });

  test("says nothing when the resources carry no region", () => {
    expect(spread([inst("a"), inst("b")])).toBe("");
  });
});
