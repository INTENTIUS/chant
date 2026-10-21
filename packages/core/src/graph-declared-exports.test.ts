import { describe, test, expect, vi } from "vitest";

/**
 * Side-by-side stacks keep their exports and imports (#4202). The live overlay
 * builds the declared canvas per stack, and that canvas dropped the member's
 * exports, so a workspace viewer had nothing to join another member's import
 * to once an environment was picked.
 */
vi.mock("./discovery/index", () => ({ discover: vi.fn(async () => ({ entities: new Map(), errors: [] })) }));
vi.mock("./graph-ir", () => ({
  buildGraphIr: vi.fn(() => ({
    nodes: [
      { id: "webAlb", kind: "AWS::ElasticLoadBalancingV2::LoadBalancer", lexicon: "aws" },
      { id: "zoneId", kind: "AWS::CloudFormation::Parameter", lexicon: "aws" },
    ],
    edges: [],
    groups: {},
    exports: [{ name: "awsEndpoint", node: "webAlb", attr: "DNSName" }],
    imports: [{ name: "zoneId", node: "zoneId" }],
  })),
}));

const { buildDeclaredPerStack } = await import("./graph-declared");

describe("buildDeclaredPerStack keeps exports and imports (#4202)", () => {
  test("an export's node is qualified like the nodes, and its name is unchanged", async () => {
    const ir = await buildDeclaredPerStack([{ name: "three-cloud-aws", src: "src" }], "/project");
    expect(ir.nodes.map((n) => n.id)).toContain("three-cloud-aws::webAlb");
    expect(ir.exports).toEqual([{ name: "awsEndpoint", node: "three-cloud-aws::webAlb", attr: "DNSName" }]);
    expect(ir.imports).toEqual([{ name: "zoneId", node: "three-cloud-aws::zoneId" }]);
    const ids = new Set(ir.nodes.map((n) => n.id));
    for (const e of ir.exports ?? []) expect(ids.has(e.node!)).toBe(true);
  });

  test("a stack without src brings no exports", async () => {
    const ir = await buildDeclaredPerStack([{ name: "unbuilt" }], "/project");
    expect(ir.exports).toBeUndefined();
    expect(ir.imports).toBeUndefined();
  });
});
