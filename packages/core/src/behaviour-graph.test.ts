/**
 * The graph seam (#2377): a request built from the graph in hand, and a
 * projection put back onto it.
 *
 * The three states #2377 names are asserted on the values that reach the IR,
 * because that IR is behold's whole input: a block per predicted node and the
 * meta, nothing at all when no prediction was asked for, and the refusal on
 * the meta with no node carrying a block.
 */

import { describe, expect, it } from "vitest";
import {
  behaviourReport,
  noBehaviourEngineRefusal,
  predictedRate,
  type PredictedBehaviour,
} from "./behaviour";
import { BEHAVIOUR_OVERLAY_ATTR, behaviourOverlay } from "./behaviour-overlay";
import { applyBehaviourOverlay, behaviourRequestFromIr } from "./behaviour-graph";
import type { GraphIR, IRNode } from "./graph-ir";

const node = (id: string, kind: string, attrs: Record<string, unknown> = {}): IRNode => ({
  id,
  kind,
  lexicon: "aws",
  attrs,
});

const ir = (nodes: IRNode[], edges: GraphIR["edges"] = []): GraphIR => ({
  nodes,
  edges,
  groups: { stacks: [], composites: [] } as unknown as GraphIR["groups"],
});

const block: PredictedBehaviour = {
  at: { traffic: "100 rps, p50" },
  cost: predictedRate(0.0416, "USD"),
  headroom: { cpu: 0.6 },
  errorRate: 0.0005,
  resilience: { failure: "one zone lost", verdict: "survives" },
  provenance: { engine: "fixture", version: "0.0.1", tolerance: "±20%", basis: "modeled" },
};

const ctx = {
  environment: "prod",
  traffic: "100 rps, p50",
  buildOutput: "",
  edgeCoverage: { verdict: "unknown" } as const,
  from: "live" as const,
};

describe("behaviourRequestFromIr", () => {
  it("names every node and carries its kind and props verbatim", () => {
    const graph = ir([node("web", "AWS::EC2::Instance", { instanceType: "t3.small" }), node("role", "AWS::IAM::Role")]);
    const req = behaviourRequestFromIr(graph, ctx);

    expect(req.entityNames).toEqual(["web", "role"]);
    expect(req.entities.get("web")).toEqual({
      entityType: "AWS::EC2::Instance",
      props: { instanceType: "t3.small" },
    });
    expect(req.traffic).toBe("100 rps, p50");
    expect(req.environment).toBe("prod");
  });

  it("passes the graph's own edges through, because the prediction is about paths", () => {
    const edges = [{ from: "web", to: "db", kind: "ref" }] as unknown as GraphIR["edges"];
    const req = behaviourRequestFromIr(ir([node("web", "X"), node("db", "Y")], edges), ctx);
    expect(req.edges).toBe(edges);
  });

  it("does not filter props down to what chant thinks matters", () => {
    // chant prices nothing, so it cannot know which field moves a figure. A
    // filtered request would hand the engine a silently incomplete entity.
    const attrs = { instanceType: "t3.small", tags: { team: "core" }, somethingChantHasNeverHeardOf: 7 };
    const req = behaviourRequestFromIr(ir([node("web", "AWS::EC2::Instance", attrs)]), ctx);
    expect(req.entities.get("web")?.props).toEqual(attrs);
  });

  it("omits stack, region and owned rather than sending undefined for them", () => {
    const req = behaviourRequestFromIr(ir([node("web", "X")]), ctx);
    expect("stack" in req).toBe(false);
    expect("region" in req).toBe(false);
    expect("owned" in req).toBe(false);
  });
});

describe("applyBehaviourOverlay", () => {
  const report = behaviourReport(
    { entityNames: ["web", "role"], traffic: "100 rps, p50", edgeCoverage: { verdict: "unknown" } },
    { engine: "fixture", version: "0.0.1", total: predictedRate(0.0416, "USD") },
    { web: block },
    { role: { reason: "unsupported-kind", detail: "a role is a grant" } },
  );

  it("puts a predicted entity's block on its own node, and the meta on the graph", () => {
    const out = applyBehaviourOverlay(ir([node("web", "X"), node("role", "Y")]), behaviourOverlay(report));

    expect(out.nodes[0].attrs[BEHAVIOUR_OVERLAY_ATTR]).toBe(block);
    const meta = out.meta?.[BEHAVIOUR_OVERLAY_ATTR] as Record<string, unknown>;
    expect(meta.engine).toBe("fixture");
    expect(meta.at).toEqual({ traffic: "100 rps, p50" });
  });

  it("leaves an unpredicted node with no _behaviour key at all", () => {
    const out = applyBehaviourOverlay(ir([node("web", "X"), node("role", "Y")]), behaviourOverlay(report));
    // Not a zeroed block: "costs nothing" and "was not priced" are different
    // claims, and a renderer cannot tell them apart after the fact.
    expect(BEHAVIOUR_OVERLAY_ATTR in out.nodes[1].attrs).toBe(false);
  });

  it("a refusal rides on the meta whole, and no node carries a block", () => {
    const out = applyBehaviourOverlay(
      ir([node("web", "X"), node("role", "Y")]),
      behaviourOverlay(noBehaviourEngineRefusal("terraform")),
    );

    const meta = out.meta?.[BEHAVIOUR_OVERLAY_ATTR] as Record<string, unknown>;
    // behold's reader branches on `refusal` before it looks for `engine`.
    expect(meta.refusal).toBeDefined();
    expect(meta.behaviour).toBe("v1");
    for (const n of out.nodes) expect(BEHAVIOUR_OVERLAY_ATTR in n.attrs).toBe(false);
  });

  it("keeps the drift overlay's attrs on the node beside the new block", () => {
    // `_behaviour` joins `_status` rather than replacing the attrs object;
    // losing the drift paint to gain a prediction would be a regression a
    // renderer shows as every node going uncoloured.
    const graph = ir([node("web", "X", { _status: "good", instanceType: "t3.small" })]);
    const out = applyBehaviourOverlay(graph, behaviourOverlay(report));

    expect(out.nodes[0].attrs._status).toBe("good");
    expect(out.nodes[0].attrs.instanceType).toBe("t3.small");
    expect(out.nodes[0].attrs[BEHAVIOUR_OVERLAY_ATTR]).toBe(block);
  });

  it("does not mutate the graph it was given", () => {
    // The caller's `ir` goes on to the lens pipeline; a prediction must not be
    // the reason a later pass sees different nodes.
    const graph = ir([node("web", "X", { _status: "good" })]);
    const before = JSON.stringify(graph);
    applyBehaviourOverlay(graph, behaviourOverlay(report));
    expect(JSON.stringify(graph)).toBe(before);
  });

  it("keeps meta keys another pass already put on the graph", () => {
    const graph = { ...ir([node("web", "X")]), meta: { _somethingElse: 1 } };
    const out = applyBehaviourOverlay(graph, behaviourOverlay(report));
    expect(out.meta?._somethingElse).toBe(1);
    expect(out.meta?.[BEHAVIOUR_OVERLAY_ATTR]).toBeDefined();
  });
});
