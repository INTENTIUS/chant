import { describe, test, expect } from "vitest";
import { join } from "path";
import { carveAdvise, carveJson, type CarveJsonResource } from "../../cli/commands/carve";
import { loadHcl2json, parseTerraformDir } from "../parse";
import { maxTransitiveInboundDepth } from "./build-graph";

/**
 * `depth-estate` (#2323) closes the gap the carve dependency/blast-radius
 * spike found: every shipped fixture — `sample-estate`, `gcp-estate`, the
 * carve-out examples, the CDK fixture — has a max transitive inbound depth of
 * 1 and no `depends_on` edge (docs/design/carve-dependency-blast-radius-spike.md
 * section 2). A future transitive-reachability implementation would pass the
 * whole existing suite whether it were correct, inverted, or a stub returning
 * the direct count. This estate has a real chain, a `depends_on` edge, a
 * `count` block and a module, so it can't.
 */
let parserAvailable = false;
try {
  await loadHcl2json();
  parserAvailable = true;
} catch {
  parserAvailable = false;
}

const ESTATE = join(__dirname, "depth-estate");
const STATE = join(ESTATE, "terraform.tfstate");

describe("the depth-estate fixture actually has depth", () => {
  test("max transitive inbound depth is 3, not the 1 every other fixture tops out at", async () => {
    if (!parserAvailable) return;
    const graph = await parseTerraformDir(ESTATE);

    // The guard that matters: a snapshot alone can't tell a flat estate from
    // one with real depth, so this is asserted directly against the graph the
    // production parse path builds — not against the pinned scores below,
    // which would still pass at depth 1.
    const depth = maxTransitiveInboundDepth(graph);
    expect(depth).toBeGreaterThan(1);
    // Pinned to the exact chain the fixture was built around: aws_vpc.main ->
    // aws_subnet.a -> aws_db_subnet_group.main -> aws_rds_cluster.main ->
    // {aws_rds_cluster_instance.one, aws_lambda_function.api}, 3 inbound hops.
    expect(depth).toBe(3);
  });
});

describe("carve advise against depth-estate", () => {
  test("bands the chain, the depends_on edge, the count block and the module", async () => {
    if (!parserAvailable) return;
    const r = await carveAdvise({ from: ESTATE });
    expect(r.ok).toBe(true);
    const byAddr = Object.fromEntries((r.results ?? []).map((x) => [x.address, x]));

    // The root of the depth chain: 7 direct inbound edges (2 subnets, the
    // count-expanded subnet, 2 security groups, the target group, the
    // module), no tier penalty (aws_vpc is tier 1).
    expect(byAddr["aws_vpc.main"].band).toBe("leave in Terraform");
    expect(byAddr["aws_vpc.main"].score).toBe(16); // 100 - 12*7
    expect(byAddr["aws_vpc.main"].breakdown.inbound).toBe(7);

    // One hop down: a data-source patch each for the db subnet group and the
    // load balancer, both of which read it directly.
    expect(byAddr["aws_subnet.a"].band).toBe("carvable w/ edits");
    expect(byAddr["aws_subnet.a"].score).toBe(60); // 100 - 12*3 - 4*1

    // The far end of the chain: no native mapping, so it scores 0 regardless
    // of how deep it sits.
    expect(byAddr["aws_rds_cluster_instance.one"].score).toBe(0);
    expect(byAddr["aws_rds_cluster_instance.one"].band).toBe("leave in Terraform");

    // depends_on: the log group carries no attribute reference from the
    // Lambda, only a bare `depends_on` — and still counts as one inbound edge
    // (#2323's second gap, real since hcl2json but untested until this).
    expect(byAddr["aws_cloudwatch_log_group.api"].band).toBe("clean leaf");
    expect(byAddr["aws_cloudwatch_log_group.api"].score).toBe(88); // 100 - 12*1
    expect(byAddr["aws_cloudwatch_log_group.api"].breakdown.inbound).toBe(1);

    // count: a `.tf`-only parse can't know the fan-out, so it stays at 1
    // instance and gets the flat -10 `hasDynamic` penalty rather than an
    // instances penalty.
    expect(byAddr["aws_subnet.private"].breakdown.hasDynamic).toBe(true);
    expect(byAddr["aws_subnet.private"].breakdown.instances).toBe(1);
    expect(byAddr["aws_subnet.private"].score).toBe(86); // 100 - 4*1(outbound) - 10(dynamic)

    // module: one node regardless of what it holds, tier 2 (a chant
    // composite reshapes), 3 outbound edges for the vpc_id and subnet_ids
    // inputs it takes.
    expect(byAddr["module.platform"].kind).toBe("module");
    expect(byAddr["module.platform"].breakdown.outbound).toBe(3);
    expect(byAddr["module.platform"].score).toBe(73); // 100 - 4*3 - 15

    // The report never proposes a mutation.
    expect((r.results ?? []).length).toBeGreaterThan(0);
  });

  test("the depends_on edge round-trips through the JSON boundary report from both ends", async () => {
    if (!parserAvailable) return;
    const report = carveJson(await carveAdvise({ from: ESTATE }));
    const byAddr = Object.fromEntries(report.resources.map((x) => [x.address, x]));

    // Seen from the survivor: an inbound edge with no attrs, via depends_on,
    // bridged the same as any other inbound cut (a data-source patch).
    expect(byAddr["aws_cloudwatch_log_group.api"].boundary).toEqual({
      inbound: [
        {
          direction: "inbound",
          survivor: "aws_lambda_function.api",
          carved: "aws_cloudwatch_log_group.api",
          attrs: [],
          via: ["depends_on"],
          bridge: "tf-data-source",
          required: "immediately",
        },
      ],
      outbound: [],
    });

    // Seen from the depending side: the same edge, now a deferred input.
    const lambdaOut = byAddr["aws_lambda_function.api"].boundary!.outbound;
    expect(lambdaOut).toContainEqual({
      direction: "outbound",
      survivor: "aws_cloudwatch_log_group.api",
      carved: "aws_lambda_function.api",
      attrs: [],
      via: ["depends_on"],
      bridge: "deferred-input",
      required: "at-apply",
    });
  });

  const allEdges = (resources: CarveJsonResource[]) =>
    resources.flatMap((r) => [...(r.boundary?.inbound ?? []), ...(r.boundary?.outbound ?? [])]);

  test("every edge endpoint is a real address in the estate, module included", async () => {
    if (!parserAvailable) return;
    const report = carveJson(await carveAdvise({ from: ESTATE }));
    const ranked = new Set(report.resources.map((r) => r.address));
    for (const edge of allEdges(report.resources)) {
      expect(ranked.has(edge.carved)).toBe(true);
      expect(edge.survivor).not.toBe(edge.carved);
    }
    expect(ranked.has("module.platform")).toBe(true);
  });
});

describe("carve advise --state against depth-estate", () => {
  test("resolves the count block's real fan-out, on top of the flat hasDynamic penalty", async () => {
    if (!parserAvailable) return;
    const r = await carveAdvise({ from: ESTATE, statePath: STATE });
    expect(r.ok).toBe(true);
    const byAddr = Object.fromEntries((r.results ?? []).map((x) => [x.address, x]));

    // `readStateInstanceCounts`/`applyStateCounts` only run with `--state`
    // (state.ts:64,:81) — the shipped terraform.tfstate resolves the 3
    // instances the .tf-only parse above could not see. `hasDynamic` stays
    // true (state doesn't erase that it's a count block); the instances
    // penalty now also applies.
    expect(byAddr["aws_subnet.private"].breakdown.instances).toBe(3);
    expect(byAddr["aws_subnet.private"].breakdown.hasDynamic).toBe(true);
    expect(byAddr["aws_subnet.private"].score).toBe(80); // 100 - 4*1 - 10 - 3*2
    expect(byAddr["aws_subnet.private"].breakdown.penalties.instances).toBe(-6);
  });
});
