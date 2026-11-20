/**
 * terraformCostHold (#4545) prices a root's `show -json` with infracost.
 * The same object is a `ci.cost` (#5334): the plan note's estimate and the
 * policy's `input.cost` run the same command over the same document as the
 * wave's hold. infracost is a fake here.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { costEstimateLines, costEstimateProblems, estimateCosts, policyCost } from "@intentius/chant/ci-product";
import { opWaveCostVerdict, opWaveCosts, opWaveHoldsProblems } from "@intentius/chant/op/op-waves-capability";
import { INFRACOST_ARGV, terraformCostHold } from "./cost-hold";

describe("terraformCostHold", () => {
  test("is infracost over {planJson}, a hold core accepts and a ci.cost", () => {
    const hold = terraformCostHold({ approveAbove: 100 });
    expect(hold).toEqual({ command: [...INFRACOST_ARGV], approveAbove: 100, format: "infracost" });
    expect(opWaveHoldsProblems({ cost: hold })).toEqual([]);
    expect(costEstimateProblems("ci.cost", hold)).toEqual([]);
    expect(() => terraformCostHold({ approveAbove: 1, command: ["infracost"] })).toThrow(/\{planJson\}/);
  });

  test("the plan note's estimate and the wave's hold read the same command over a root's plan document", () => {
    const dir = mkdtempSync(join(tmpdir(), "tf-cost-"));
    const planJson = join(dir, "tfplan.json");
    writeFileSync(planJson, JSON.stringify({ resource_changes: [] }));
    // terraform-apply's plan artifact names its show -json as planJson.
    const artifact = { planFile: join(dir, "tfplan"), planDigest: "d", planJson };
    const hold = terraformCostHold({ approveAbove: 100, currency: "EUR" });
    const seen: string[][] = [];
    const infracost = (argv: string[]) => {
      seen.push(argv);
      return { status: 0, stdout: JSON.stringify({ currency: "EUR", totalMonthlyCost: "180", pastTotalMonthlyCost: "40", diffTotalMonthlyCost: "140" }), stderr: "" };
    };
    const estimate = estimateCosts(hold, [{ member: "envs/prod/network", artifact, empty: false }], dir, infracost);
    expect(seen[0]).toEqual(["infracost", "breakdown", "--path", planJson, "--format", "json", "--log-level", "error"]);
    expect(estimate).toEqual({
      estimator: "infracost",
      format: "infracost",
      currency: "EUR",
      monthlyDelta: 140,
      monthlyTotal: 180,
      pastMonthlyTotal: 40,
      members: [{ member: "envs/prod/network", monthlyDelta: 140, monthlyTotal: 180, pastMonthlyTotal: 40, currency: "EUR" }],
      unestimated: [],
      approveAbove: 100,
      over: true,
    });
    expect(policyCost(estimate, "envs/prod/network").member).toMatchObject({ monthlyDelta: 140 });
    expect(costEstimateLines(estimate, "root")).toContain("The monthly change is over 100.00 EUR, so this plan needs an approval of its own digest.");
    const wave = opWaveCostVerdict(hold, opWaveCosts(hold, [{ target: "envs/prod/network", plan: "p", artifact, empty: false }], dir, infracost));
    expect(wave.monthlyDelta).toBe(estimate.monthlyDelta);
    expect(wave.hold).toMatch(/over holds.cost.approveAbove/);
  });
});
