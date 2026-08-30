import { describe, test, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { carveAdvise, carveJson, formatCarveReport, CARVE_REPORT_VERSION } from "../cli/commands/carve";
import { carveEmit } from "../cli/commands/carve-emit";
import { carveBridge } from "../cli/commands/carve-bridge";
import { carveApply } from "../cli/commands/carve-apply";

const FIXTURES = join(__dirname, "__fixtures__");
const ASSEMBLY = join(FIXTURES, "cdk.out");
const DUMMY = join(FIXTURES, "cdk.out-dummy");

/**
 * `chant carve advise` over a committed CDK cloud assembly (#1056). No CDK CLI,
 * no network, no wasm parser — the assembly is JSON and it is in the repo.
 */
describe("carve advise --from <cdk.out>", () => {
  test("routes on the directory's contents, not a second flag", async () => {
    const r = await carveAdvise({ from: ASSEMBLY });
    expect(r.ok).toBe(true);
    expect(r.source).toBe("cdk");
  });

  test("ranks constructs into the same bands the Terraform path uses", async () => {
    const r = await carveAdvise({ from: ASSEMBLY });
    const byAddress = new Map((r.results ?? []).map((x) => [x.address, x]));

    // 100 - 12 inbound (the cross-stack import) on a tier-1 bucket.
    expect(byAddress.get("DataStack/Assets")).toMatchObject({ score: 88, band: "clean leaf", mapsTo: "AWS::S3::Bucket" });
    // 100 - 4x2 outbound - 15 tier2 - 10 asset.
    expect(byAddress.get("AppStack/Handler")).toMatchObject({ score: 67, band: "carvable w/ edits" });
    // A module (an L3 subtree) takes the same tier-2 penalty a Terraform module does.
    expect(byAddress.get("AppStack/Api")).toMatchObject({ score: 69, kind: "module" });
    expect(byAddress.get("AppStack/Api")?.mapsTo).toBeUndefined();
  });

  test("a construct ranks once, with its CloudFormation resources folded in", async () => {
    const r = await carveAdvise({ from: ASSEMBLY });
    const addresses = (r.results ?? []).map((x) => x.address);
    expect(addresses).toContain("AppStack/Handler");
    expect(addresses.filter((a) => a.startsWith("AppStack/Handler"))).toHaveLength(1);

    const handler = r.results?.find((x) => x.address === "AppStack/Handler");
    expect(handler?.members?.map((m) => m.id).sort()).toEqual([
      "Handler886CB40B",
      "HandlerServiceRoleDefaultPolicy4C43A1F9",
      "HandlerServiceRoleFCDC14AE",
    ]);
  });

  test("scaffolding does not appear in the report", async () => {
    const r = await carveAdvise({ from: ASSEMBLY });
    const text = JSON.stringify(carveJson(r));
    expect(text).not.toContain("CDKMetadata");
    expect(text).not.toContain("AWS::CDK::Metadata");
    expect(text).not.toContain("BootstrapVersion");
  });

  test("a cross-stack Fn::ImportValue is a boundary edge from both ends", async () => {
    const payload = carveJson(await carveAdvise({ from: ASSEMBLY }));
    const producer = payload.resources.find((x) => x.address === "DataStack/Assets");
    const consumer = payload.resources.find((x) => x.address === "AppStack/Handler");

    expect(producer?.boundary?.inbound).toContainEqual({
      direction: "inbound",
      survivor: "AppStack/Handler",
      carved: "DataStack/Assets",
      attrs: ["Export"],
      via: ["PolicyDocument"],
      bridge: "cdk-import",
      required: "immediately",
      crossStack: true,
    });
    expect(consumer?.boundary?.outbound).toContainEqual({
      direction: "outbound",
      survivor: "DataStack/Assets",
      carved: "AppStack/Handler",
      attrs: ["Export"],
      via: ["PolicyDocument"],
      bridge: "deferred-input",
      required: "at-apply",
      crossStack: true,
    });
  });

  test("a stack Output reading a construct bridges as an output rewrite", async () => {
    const payload = carveJson(await carveAdvise({ from: ASSEMBLY }));
    const table = payload.resources.find((x) => x.address === "DataStack/Table");
    expect(table?.boundary?.inbound).toContainEqual({
      direction: "inbound",
      survivor: "output.DataStack.TableName",
      carved: "DataStack/Table",
      attrs: ["Ref"],
      via: ["Value"],
      bridge: "cfn-output-rewrite",
      required: "immediately",
    });
    expect(table?.breakdown).toMatchObject({ inbound: 0, outputs: 1 });
  });

  test("a dummy-value assembly scores 0 with the reason, not a plausible score", async () => {
    const r = await carveAdvise({ from: DUMMY });
    expect(r.ok).toBe(true);
    expect(r.results?.length).toBeGreaterThan(0);
    for (const scored of r.results ?? []) {
      expect(scored.score).toBe(0);
      expect(scored.notes?.join(" ")).toContain("unresolved context lookup");
    }
    const payload = carveJson(r);
    expect(payload.diagnostics?.join(" ")).toContain("unresolved context lookup");
    expect(formatCarveReport(r)).toContain("unresolved context lookup");
  });

  test("the report advises and never suggests a mutation", async () => {
    const r = await carveAdvise({ from: ASSEMBLY });
    const text = formatCarveReport(r);
    expect(text).toContain("CDK cloud-assembly carve-out advisory");
    expect(text).toContain("Advises only");
    expect(text).toContain("LEAVE IN CDK");
    expect(text).not.toMatch(/cdk deploy|cdk destroy|terraform state rm/i);
  });

  test("--report writes the same payload to a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-cdk-carve-"));
    try {
      const reportFile = join(dir, "report.json");
      const r = await carveAdvise({ from: ASSEMBLY, reportFile });
      expect(r.ok).toBe(true);
      const payload = JSON.parse(readFileSync(reportFile, "utf-8"));
      expect(payload).toEqual(carveJson(r));
      expect(payload.count).toBe(r.results?.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--state is a Terraform option and is refused, not ignored", async () => {
    const r = await carveAdvise({ from: ASSEMBLY, statePath: join(ASSEMBLY, "manifest.json") });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("--state is a Terraform option");
  });
});

/**
 * The report is a cross-tool contract (behold's carve lens reads it). The CDK
 * source is additive within schema version 1: it introduces no field an
 * existing reader keys on, and changes no field's type or meaning.
 */
describe("the versioned report contract", () => {
  test("the CDK source does not bump the schema version", async () => {
    const payload = carveJson(await carveAdvise({ from: ASSEMBLY }));
    expect(payload.version).toBe(CARVE_REPORT_VERSION);
    expect(CARVE_REPORT_VERSION).toBe(1);
  });

  test("every field an existing reader validates keeps its type", async () => {
    const payload = carveJson(await carveAdvise({ from: ASSEMBLY }));
    // behold refuses a report whose entries are not {address: string, score:
    // number, band: string}, and reads `kind` as "resource" | "module".
    expect(Array.isArray(payload.resources)).toBe(true);
    for (const resource of payload.resources) {
      expect(typeof resource.address).toBe("string");
      expect(typeof resource.score).toBe("number");
      expect(typeof resource.band).toBe("string");
      expect(["resource", "module"]).toContain(resource.kind);
      expect(["clean leaf", "carvable w/ edits", "leave in Terraform"]).toContain(resource.band);
    }
  });

  test("the score arithmetic still adds up from the penalty terms", async () => {
    // behold reproduces a score as `100 + sum(penalties)`, so an added term
    // (the CDK asset penalty) has to be summable rather than special-cased.
    const payload = carveJson(await carveAdvise({ from: ASSEMBLY }));
    for (const resource of payload.resources) {
      if (resource.breakdown.tier === null || resource.score === 0) continue;
      const total = Object.values(resource.breakdown.penalties).reduce((sum, n) => sum + n, 0);
      expect(100 + total).toBe(resource.score);
    }
  });

  test("the source discriminator is present on both paths", async () => {
    expect(carveJson(await carveAdvise({ from: ASSEMBLY })).source).toBe("cdk");
    // A result with no source at all (an older caller) still reads as Terraform.
    expect(carveJson({ ok: true, from: "x", results: [] }).source).toBe("terraform");
  });
});

describe("the Terraform-only phases", () => {
  test("refuse a cloud assembly by name instead of reporting an empty estate", async () => {
    const emit = await carveEmit(
      { from: ASSEMBLY, select: "AppStack/Handler", statePath: "unused.tfstate" },
      // Refused before anything is read, so neither dependency is reached.
      { plugins: [], liveImport: async () => { throw new Error("no cloud call in an advise-only path"); } },
    );
    expect(emit.ok).toBe(false);
    expect(emit.error).toContain("carve emit");
    expect(emit.error).toContain("carve advise");

    const bridge = await carveBridge({ from: ASSEMBLY, select: "AppStack/Handler" });
    expect(bridge.ok).toBe(false);
    expect(bridge.error).toContain("carve bridge");

    const apply = await carveApply({ from: ASSEMBLY, select: "AppStack/Handler", env: "prod" });
    expect(apply.ok).toBe(false);
    expect(apply.error).toContain("carve apply");
  });
});
