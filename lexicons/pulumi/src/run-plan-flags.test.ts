/**
 * `--refresh` and `--target-dependents` through the pulumi lexicon's
 * allowlists (#4627): both in the preview and in stock `pulumi up`, in the
 * tail's order, `--target-dependents` only after a `--target`, and no
 * `--refresh` on plunge's `up --plan`, which applies a saved plan whose
 * preview refreshed. Written for the ci-products post-merge pass.
 */
import { describe, expect, test } from "vitest";
import { plungeUpArgs, pulumiUpArgs, pulumiUpPreviewArgs, runAllowedPlunge, runAllowedPulumi, runApplyPlunge, runApplyPulumi, type PulumiRunner } from "./run";
import { createPulumiUpCapability } from "./pulumi-up";

function fake(): { run: PulumiRunner; calls: string[][] } {
  const calls: string[][] = [];
  return { run: async (args) => (calls.push(args), { stdout: "" }), calls };
}

describe("--refresh and --target-dependents (#4627)", () => {
  test("the preview carries them in the tail's order", async () => {
    const args = pulumiUpPreviewArgs({ stack: "dev", refresh: true, targets: ["urn:a"], targetDependents: true });
    expect(args).toEqual(["preview", "--json", "--show-sames", "--stack", "dev", "--refresh", "--target", "urn:a", "--target-dependents"]);
    const { run, calls } = fake();
    await runAllowedPulumi(run, args, "/tmp");
    await runAllowedPlunge(run, args, "/tmp");
    expect(calls).toHaveLength(2);
  });

  test("--target-dependents is dropped without a target", () => {
    expect(pulumiUpPreviewArgs({ stack: "dev", targetDependents: true })).not.toContain("--target-dependents");
  });

  test("stock up takes both; plunge up --plan takes --target-dependents and no --refresh", async () => {
    const { run, calls } = fake();
    await runApplyPulumi(run, pulumiUpArgs({ stack: "dev", refresh: true, targets: ["urn:a"], targetDependents: true }), "/tmp");
    await runApplyPlunge(run, plungeUpArgs({ plan: "/tmp/p.json", stack: "dev", targets: ["urn:a"], targetDependents: true }), "/tmp");
    expect(calls).toEqual([
      ["up", "--yes", "--json", "--stack", "dev", "--refresh", "--target", "urn:a", "--target-dependents"],
      ["up", "--plan", "/tmp/p.json", "--yes", "--json", "--stack", "dev", "--target", "urn:a", "--target-dependents"],
    ]);
    await expect(runApplyPlunge(run, ["up", "--plan", "/tmp/p.json", "--yes", "--json", "--stack", "dev", "--refresh"], "/tmp")).rejects.toThrow(/applies a plunge stack only as/);
  });

  test("out of order, or --target-dependents with no target, is refused", async () => {
    const { run, calls } = fake();
    for (const tail of [["--target-dependents"], ["--target", "urn:a", "--refresh"], ["--target-dependents", "--target", "urn:a"], ["--refresh", "--refresh"]]) {
      await expect(runApplyPulumi(run, ["up", "--yes", "--json", "--stack", "dev", ...tail], "/tmp"), tail.join(" ")).rejects.toThrow(/applies a Pulumi stack only as/);
    }
    expect(calls).toEqual([]);
  });

  test("the capability says it takes both", () => {
    expect(createPulumiUpCapability().planFlags).toEqual({ refresh: "accept", targetDependents: "accept" });
  });
});
