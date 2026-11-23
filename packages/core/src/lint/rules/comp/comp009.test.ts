/**
 * COMP009 (#5482): a component's gate step applies in an environment whose
 * pipeline stage already has a gate. The check runs over fixture components
 * with the gated stages handed in, the way `chant lint` hands them; the
 * pipeline read (`gatedStagesOf`) runs over a temporary member directory.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runComponentChecks, type GatedStage } from "../../component-checks";
import { comp009StageAndComponentBothGateRule, gatedStagesOf } from "./comp009-stage-and-component-both-gate";

const FIXTURES = join(import.meta.dirname, "..", "__fixtures__", "comp", "comp009");
const PROD = new Map<string, GatedStage>([["prod", { file: ".chant/pipeline.ts" }]]);

describe("COMP009: stage-and-component-both-gate", () => {
  it("warns on a gate whose environments include a gated stage, and on one with no environments, naming both", async () => {
    const diagnostics = await runComponentChecks(join(FIXTURES, "fail"), [comp009StageAndComponentBothGateRule], { gatedStages: PROD });
    expect(diagnostics.map((d) => d.component).sort()).toEqual(["api", "worker"]);
    for (const d of diagnostics) {
      expect(d.checkId).toBe("COMP009");
      expect(d.severity).toBe("warning");
      expect(d.message).toContain('"prod" stage (.chant/pipeline.ts)');
    }
    const api = diagnostics.find((d) => d.component === "api")!;
    expect(api.message).toContain('gate "approve-api"');
    expect(diagnostics).toHaveLength(2);
  });

  it("passes a gate in an environment whose stage declares none", async () => {
    expect(await runComponentChecks(join(FIXTURES, "pass"), [comp009StageAndComponentBothGateRule], { gatedStages: PROD })).toHaveLength(0);
  });

  it("flags nothing when no gated stages were resolved", async () => {
    expect(await runComponentChecks(join(FIXTURES, "fail"), [comp009StageAndComponentBothGateRule])).toHaveLength(0);
    expect(await runComponentChecks(join(FIXTURES, "fail"), [comp009StageAndComponentBothGateRule], { gatedStages: new Map() })).toHaveLength(0);
  });
});

describe("gatedStagesOf", () => {
  const dir = mkdtempSync(join(tmpdir(), "comp009-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("is empty for a member with no pipeline", async () => {
    expect((await gatedStagesOf(dir)).size).toBe(0);
  });

  it("lists the stages whose gate waits for an approval", async () => {
    mkdirSync(join(dir, ".chant"));
    writeFileSync(
      join(dir, ".chant", "pipeline.ts"),
      `import { pipeline } from "@intentius/chant/pipeline";

export default pipeline({
  name: "ship",
  defaults: { op: "ship", step: { kind: "pulumi-up", stack: "{target}" }, runner: "ubuntu-latest" },
  stages: [
    { name: "dev", waves: [{ name: "dev", runs: [{ target: "dev" }] }], gate: { policy: "never" } },
    { name: "staging", waves: [{ name: "staging", runs: [{ target: "staging" }] }] },
    { name: "prod", waves: [{ name: "prod", runs: [{ target: "prod" }] }], gate: { policy: "always" } },
  ],
});
`,
    );
    const stages = await gatedStagesOf(dir);
    expect([...stages.keys()]).toEqual(["prod"]);
    expect(stages.get("prod")?.file).toBe(".chant/pipeline.ts");
  });
});
