import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { opWaveCostVerdict, opWaveCosts, opWaveHoldsProblems } from "@intentius/chant/op/op-waves-capability";
import { pulumiCostHold } from "./cost-hold";
import { createPulumiUpCapability, type PulumiUpArtifact } from "./pulumi-up";
import { pulumiStreamPreview } from "./engine-events";
import type { PulumiRunner } from "./run";
import type { DeployContext } from "@intentius/chant/components/capability";

const testdata = join(import.meta.dirname, "testdata");
const dir = join(testdata, "pulumi-preview");
const stream = readFileSync(join(testdata, "pulumi-stream", "preview-stream.ndjson"), "utf-8");

describe("pulumiCostHold", () => {
  test("takes the command, defaults to the chant estimate format and carries the same keys as the terraform preset", () => {
    expect(pulumiCostHold({ approveAbove: 100, command: ["price", "{planJson}"] })).toEqual({ command: ["price", "{planJson}"], approveAbove: 100, format: "chant" });
    expect(pulumiCostHold({ approveAbove: 5, command: ["infracost", "--path", "{planJson}"], format: "infracost", currency: "EUR" })).toEqual({
      command: ["infracost", "--path", "{planJson}"],
      approveAbove: 5,
      format: "infracost",
      currency: "EUR",
    });
  });

  test("refuses a command that does not name {planJson}, and has no default command", () => {
    expect(() => pulumiCostHold({ approveAbove: 1, command: ["price"] })).toThrow(/\{planJson\}/);
    expect(() => pulumiCostHold({ approveAbove: 1, command: [] })).toThrow(/command/);
    expect(() => pulumiCostHold({ approveAbove: 1 } as never)).toThrow(/command/);
  });

  test("is a hold core accepts", () => {
    expect(opWaveHoldsProblems({ cost: pulumiCostHold({ approveAbove: 0, command: ["price", "{planJson}"] }) })).toEqual([]);
  });
});

describe("a pulumi-up plan feeds the cost hold", () => {
  const ctx: DeployContext = { env: "prod", component: "site" };
  const runner: PulumiRunner = async (args) => ({ stdout: args[0] === "preview" ? stream : "{}" });

  for (const engine of ["plunge", "pulumi"] as const) {
    test(`${engine}: artifact.planJson is the preview document and {planJson} reaches the command`, async () => {
      const scratch = mkdtempSync(join(tmpdir(), "chant-pulumi-cost-"));
      const cap = createPulumiUpCapability({ ...(engine === "plunge" ? { plunge: runner } : { run: runner }), env: {}, tmp: scratch, snapshots: null });
      const planned = await cap.plan!(ctx, { dir, stack: "floci", engine });
      const artifact = planned.artifact as PulumiUpArtifact;
      expect(artifact.planJson?.startsWith(scratch)).toBe(true);
      expect(JSON.parse(readFileSync(artifact.planJson!, "utf-8"))).toEqual(pulumiStreamPreview(stream));

      const hold = pulumiCostHold({ approveAbove: 100, command: ["price", "{planJson}"] });
      const seen: string[][] = [];
      const costs = opWaveCosts(hold, [{ target: "floci", plan: "p", artifact, empty: false }], dir, (argv) => {
        seen.push(argv);
        return { status: 0, stdout: JSON.stringify({ monthlyDelta: 250 }), stderr: "" };
      });
      expect(seen).toEqual([["price", artifact.planJson]]);
      const verdict = opWaveCostVerdict(hold, costs);
      expect(verdict.monthlyDelta).toBe(250);
      expect(verdict.hold).toMatch(/over holds.cost.approveAbove/);
      expect(opWaveCostVerdict(hold, [{ target: "floci", monthlyDelta: 10 }]).hold).toBeUndefined();
    });
  }
});
