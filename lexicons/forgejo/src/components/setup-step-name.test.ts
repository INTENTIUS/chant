/**
 * #4932: a product's setup steps take a name, so its login step renders
 * named on Forgejo, in the Op waves pipeline's wave jobs and in the
 * scheduled Op's job.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import type { ScheduledOpSpec } from "@intentius/chant/lexicon";
import { parseYAML } from "@intentius/chant/yaml";
import { generateForgejoOpWavesPipeline } from "./generate-op-waves-pipeline";
import { generateForgejoOpPipeline } from "./generate-op-pipeline";

type Step = Record<string, unknown>;
const allSteps = (yaml: string): Step[] => Object.values((parseYAML(yaml) as { jobs: Record<string, { steps: Step[] }> }).jobs).flatMap((j) => j.steps);

describe("named setup steps on Forgejo (#4932)", () => {
  test("a wave's setup step and a scheduled Op's render with their names", () => {
    const login = { name: "Log in to the cloud", run: "trade dev" };
    const spec: OpWavesSpec = { name: "migrations", op: "migrate", plan: ["./bin/plan", "{target}", "{plan}"], waves: [{ name: "dev", runs: [{ target: "dev" }], gate: "never", setup: [login] }] };
    expect(allSteps(generateForgejoOpWavesPipeline(spec, { specFile: "waves.json" }).files[0]!.yaml)).toContainEqual(login);
    const watch: ScheduledOpSpec = { name: "watch-dev", trigger: { kind: "schedule", cron: "0 * * * *" }, setup: [login] };
    expect(allSteps(generateForgejoOpPipeline([watch]).files[0]!.yaml)).toContainEqual(login);
  });
});
