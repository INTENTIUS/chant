/**
 * The disagreement lint (#2549, #2524 D6) in #1939's cross-build-root mode:
 * LNK001 over the composed graph's links, and the cross-root checks the
 * members' lexicons ship.
 */
import { describe, test, expect } from "vitest";
import { createCrossRootContext, type CrossRootCheck } from "../lint/post-synth";
import type { WorkspaceGraph } from "./compose-graph";
import { crossRootLinks, crossRootLint, lnk001 } from "./cross-root-lint";
import { crossRootInputs } from "./workspace-run";

function member(name: string, status: "composed" | "skipped" = "composed") {
  return { name, dir: name, kind: "chant", status, reason: null, chant: null, irVersion: 1, live: false };
}

const declared = (consumer: string, producer: string, output: string) => ({ consumer, producer, output, kind: "output", origin: "declared", resolves: "source", status: "resolved", label: "exact", input: null, reason: null });
const inferred = (consumer: string, producer: string, output: string, input: string) => ({ consumer, producer, output, kind: "output", origin: "inferred:joinKey", resolves: "source", status: "resolved", label: "exact", input, reason: null });

function graph(links: unknown[]): WorkspaceGraph {
  return {
    version: 1,
    workspace: { name: "acme", root: "." },
    members: [member("network"), member("legacy-net"), member("api")],
    nodes: [
      { id: "network/vpc", kind: "AWS::EC2::VPC", lexicon: "aws", member: "network", attrs: {} },
      { id: "api/fn", kind: "AWS::Lambda::Function", lexicon: "aws", member: "api", attrs: {} },
      { id: "api/svc", kind: "Deployment", lexicon: "k8s", member: "api", attrs: {} },
    ],
    edges: [],
    groups: { byMember: {} },
    exports: [],
    imports: [],
    links,
    collectors: [],
    records: [],
  } as unknown as WorkspaceGraph;
}

describe("LNK001: a declared link and the graph's join disagree", () => {
  test("flags a declaration that names another producer than the one the consumer's graph joins", () => {
    const g = graph([declared("api", "legacy-net", "vpcId"), inferred("api", "network", "VpcId", "vpcId")]);
    const ctx = createCrossRootContext(crossRootInputs(g), { links: crossRootLinks(g.links) });
    const found = lnk001.check(ctx);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ checkId: "LNK001", severity: "warning", root: "api", entity: "vpcId" });
    expect(found[0]!.message).toContain("declares a link to legacy-net's output vpcId");
    expect(found[0]!.message).toContain("network's output VpcId");
  });

  test("agrees when the declaration names the producer the graph joins, or a handle the join doesn't touch", () => {
    for (const links of [
      [declared("api", "network", "subnetIds"), inferred("api", "network", "VpcId", "vpcId")],
      [declared("api", "legacy-net", "dnsZone"), inferred("api", "network", "VpcId", "vpcId")],
    ]) {
      const g = graph(links);
      expect(lnk001.check(createCrossRootContext(crossRootInputs(g), { links: crossRootLinks(g.links) }))).toEqual([]);
    }
  });

  test("says nothing about a consumer whose graph was not read, or with no links passed", () => {
    const g = graph([declared("api", "legacy-net", "vpcId"), inferred("api", "network", "VpcId", "vpcId")]);
    g.members = g.members.map((m) => (m.name === "api" ? { ...m, status: "skipped" as const } : m));
    expect(lnk001.check(createCrossRootContext(crossRootInputs(g), { links: crossRootLinks(g.links) }))).toEqual([]);
    expect(lnk001.check(createCrossRootContext(crossRootInputs(graph([]))))).toEqual([]);
  });
});

describe("crossRootLint", () => {
  test("runs LNK001 and the cross-root checks of each lexicon the members' graphs name, and reports a lexicon it can't load", async () => {
    const asked: string[] = [];
    const awsCheck: CrossRootCheck = {
      id: "AWSX01",
      description: "sees every root",
      scope: "cross-root",
      check: (ctx) => [{ checkId: "AWSX01", severity: "info", message: `${ctx.roots.length} roots, ${ctx.links?.length ?? 0} links` }],
    };
    const result = await crossRootLint(graph([declared("api", "legacy-net", "vpcId"), inferred("api", "network", "VpcId", "vpcId")]), {
      load: async (lexicon) => {
        asked.push(lexicon);
        if (lexicon === "k8s") throw new Error("Cannot find package '@intentius/chant-lexicon-k8s'");
        return [awsCheck, { id: "PLAIN", description: "per-build, never run here", check: () => [] }];
      },
    });
    expect(asked).toEqual(["aws", "k8s"]);
    expect(result.checks).toEqual(["LNK001", "AWSX01"]);
    expect(result.findings.map((f) => f.checkId)).toEqual(["LNK001", "AWSX01"]);
    expect(result.findings[1]!.message).toBe("3 roots, 2 links");
    expect(result.unloaded).toEqual([{ lexicon: "k8s", reason: "Cannot find package '@intentius/chant-lexicon-k8s'" }]);
  });
});
