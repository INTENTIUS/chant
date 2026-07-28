import { describe, test, expect } from "vitest";
import { __searchInternals } from "./search";

const { parseQuery, matchTerm, formatRow } = __searchInternals;

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

  test("--show adds named primitive attributes only", () => {
    const n = node("web", "AWS::EC2::Instance", { physicalId: "i-1", InstanceType: "t3.micro", Tags: [{}] });
    expect(formatRow(n, ["InstanceType", "Tags"])).toBe("web  AWS::EC2::Instance  i-1  InstanceType=t3.micro");
  });
});
