import { describe, test, expect } from "vitest";
import { join } from "path";
import { carveAdvise, formatCarveReport } from "../../cli/commands/carve";
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
