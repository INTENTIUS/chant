import { describe, test, expect } from "vitest";
import { join } from "path";
import {
  carveAdvise,
  carveJson,
  formatCarveReport,
  CARVE_REPORT_VERSION,
  type CarveJsonResource,
} from "../../cli/commands/carve";
import { loadHcl2json } from "../parse";

/**
 * End-to-end demo test (#214 T5): run the advisor against the runnable sample
 * estate the docs point at, and pin the headline scores so the doc examples
 * stay honest. Skips cleanly when the optional wasm parser is absent.
 */
let parserAvailable = false;
try {
  await loadHcl2json();
  parserAvailable = true;
} catch {
  parserAvailable = false;
}

const ESTATE = join(__dirname, "sample-estate");

describe("carve advise against the sample estate", () => {
  test("bands the estate the way the docs describe", async () => {
    if (!parserAvailable) return;
    const r = await carveAdvise({ from: ESTATE });
    expect(r.ok).toBe(true);
    const byAddr = Object.fromEntries((r.results ?? []).map((x) => [x.address, x]));

    // Clean leaves
    expect(byAddr["aws_s3_bucket.assets"].band).toBe("clean leaf");
    expect(byAddr["aws_s3_bucket.assets"].score).toBe(88); // 1 inbound (Lambda); versioning folded
    expect(byAddr["aws_cloudwatch_log_group.api"].score).toBe(100); // clean, no edges

    // Folded sub-resource is not ranked on its own
    expect(byAddr["aws_s3_bucket_versioning.assets"]).toBeUndefined();

    // A subnet is a clean leaf (one outbound edge to the VPC).
    expect(byAddr["aws_subnet.a"].score).toBe(96);

    // The VPC three subnets hang off of is carvable, but with boundary work.
    expect(byAddr["aws_vpc.main"].band).toBe("carvable w/ edits");
    expect(byAddr["aws_vpc.main"].score).toBe(64); // 100 - 12*3 inbound

    // Unsupported provider scores 0 → leave in Terraform
    expect(byAddr["random_pet.suffix"].score).toBe(0);
    expect(byAddr["random_pet.suffix"].band).toBe("leave in Terraform");

    // The report never proposes a mutation.
    const text = formatCarveReport(r);
    expect(text).not.toMatch(/state rm|apply|destroy/i);
  });
});

/**
 * The JSON payload as a cross-tool contract (#1636): a schema version, and the
 * boundary edge LISTS beside the counts. behold's carve lens renders these —
 * the counts alone can't be paired back into edges (this estate has 4 inbound
 * and 4 outbound, which admits several matchings), so the lists are the thing
 * that makes a predicted diff drawable.
 */
describe("carve advise --json against the sample estate", () => {
  test("is a versioned report whose resources carry their boundary edges", async () => {
    if (!parserAvailable) return;
    const report = carveJson(await carveAdvise({ from: ESTATE }));

    expect(report.version).toBe(CARVE_REPORT_VERSION);
    expect(report.count).toBe(8);
    expect(report.resources).toHaveLength(8);

    const byAddr = Object.fromEntries(report.resources.map((x) => [x.address, x]));

    // The VPC's three subnets: each one a data-source patch to surviving TF.
    expect(byAddr["aws_vpc.main"].boundary!.inbound).toEqual([
      { direction: "inbound", survivor: "aws_subnet.a", carved: "aws_vpc.main", attrs: ["id"], via: ["vpc_id"], bridge: "tf-data-source", required: "immediately" },
      { direction: "inbound", survivor: "aws_subnet.b", carved: "aws_vpc.main", attrs: ["id"], via: ["vpc_id"], bridge: "tf-data-source", required: "immediately" },
      { direction: "inbound", survivor: "aws_subnet.c", carved: "aws_vpc.main", attrs: ["id"], via: ["vpc_id"], bridge: "tf-data-source", required: "immediately" },
    ]);
    expect(byAddr["aws_vpc.main"].boundary!.outbound).toEqual([]);

    // The same cut, seen from the other end: the subnet's carve defers a value.
    expect(byAddr["aws_subnet.a"].boundary!.outbound).toEqual([
      { direction: "outbound", survivor: "aws_vpc.main", carved: "aws_subnet.a", attrs: ["id"], via: ["vpc_id"], bridge: "deferred-input", required: "at-apply" },
    ]);

    // A clean leaf nothing touches reports two empty lists, not a missing key:
    // "none" is a claim the advisor is willing to make.
    expect(byAddr["aws_cloudwatch_log_group.api"].boundary).toEqual({ inbound: [], outbound: [] });

    // The Lambda reads two of the bucket's attributes — one edge, both attrs.
    expect(byAddr["aws_lambda_function.api"].boundary!.outbound).toEqual([
      { direction: "outbound", survivor: "aws_s3_bucket.assets", carved: "aws_lambda_function.api", attrs: ["arn", "bucket"], via: ["environment"], bridge: "deferred-input", required: "at-apply" },
    ]);
  });

  test("every edge endpoint is a real Terraform address in the estate", async () => {
    if (!parserAvailable) return;
    const report = carveJson(await carveAdvise({ from: ESTATE }));
    const ranked = new Set(report.resources.map((r) => r.address));

    for (const edge of allEdges(report.resources)) {
      // The carved side is always ranked — it is the resource reporting it.
      expect(ranked.has(edge.carved)).toBe(true);
      // The survivor side is a real address too. Every survivor in this estate
      // is itself carvable, so it is ranked; in general a survivor may be an
      // unranked address (a folded sub-resource's parent is never one, but an
      // unsupported type is), which is why this checks the estate's own set.
      expect(ranked.has(edge.survivor)).toBe(true);
      expect(edge.survivor).not.toBe(edge.carved);
    }
  });

  test("a folded sub-resource is never an edge endpoint — it carves with its parent", async () => {
    if (!parserAvailable) return;
    const report = carveJson(await carveAdvise({ from: ESTATE }));
    const endpoints = allEdges(report.resources).flatMap((e) => [e.survivor, e.carved]);

    // `aws_s3_bucket_versioning.assets` references its bucket, but that edge is
    // internal to the bucket's carve set: not boundary work, and not an endpoint.
    expect(endpoints).not.toContain("aws_s3_bucket_versioning.assets");
    expect(report.resources.map((r) => r.address)).not.toContain("aws_s3_bucket_versioning.assets");
  });

  test("the counts and the edge lists tell the same story", async () => {
    if (!parserAvailable) return;
    const report = carveJson(await carveAdvise({ from: ESTATE }));

    // `breakdown.inbound`/`outbound`/`outputs` are what the score was computed
    // from and stay for backward compatibility. They must agree with the lists,
    // or the arithmetic a reader prints beside the drawn edges is a lie. The
    // inbound list holds both resource and output survivors (#1638), so it is
    // the two counts together.
    for (const r of report.resources) {
      expect([r.address, r.boundary!.inbound.length]).toEqual([r.address, r.breakdown.inbound + r.breakdown.outputs]);
      expect([r.address, r.boundary!.outbound.length]).toEqual([r.address, r.breakdown.outbound]);
    }

    const inbound = report.resources.reduce((s, r) => s + r.breakdown.inbound, 0);
    const outbound = report.resources.reduce((s, r) => s + r.breakdown.outbound, 0);
    expect([inbound, outbound]).toEqual([4, 4]);

    // Each cut is reported from both ends — inbound from the depended-on side,
    // outbound from the depending side — so the two totals are the same set of
    // edges seen twice. Keyed in dependency direction, that is 4 distinct cuts.
    const cuts = new Set(
      allEdges(report.resources).map((e) =>
        e.direction === "inbound" ? `${e.survivor} -> ${e.carved}` : `${e.carved} -> ${e.survivor}`,
      ),
    );
    expect([...cuts].sort()).toEqual([
      "aws_lambda_function.api -> aws_s3_bucket.assets",
      "aws_subnet.a -> aws_vpc.main",
      "aws_subnet.b -> aws_vpc.main",
      "aws_subnet.c -> aws_vpc.main",
    ]);
  });
});

const allEdges = (resources: CarveJsonResource[]) =>
  resources.flatMap((r) => [...(r.boundary?.inbound ?? []), ...(r.boundary?.outbound ?? [])]);
