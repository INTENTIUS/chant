/**
 * The replan step (chant#5345) in the jobs chant renders for github. A wave
 * job runs `chant run wave`, which runs `chant components replan` for the
 * runs it applied once the wave applied, when `replanDependents` in the
 * spec it reads at base names one. The rendered files are the same with
 * the key set or unset: the step comes from that spec, read at run time
 * (`chant pipeline spec --stage` for a pipeline), so it never needs a job
 * of its own.
 */

import { describe, expect, test } from "vitest";
import { asPipelineSpec } from "@intentius/chant/pipeline/spec";
import { stageWavesSpec } from "@intentius/chant/pipeline/stages";
import { generatePipeline } from "@intentius/chant/pipeline/generate";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { githubPlugin } from "../plugin";

const pipeline = (stage: Record<string, unknown>) =>
  asPipelineSpec({
    name: "deliver",
    defaults: { op: "deliver", step: { kind: "pulumi-up", stack: "{target}" } },
    stages: [
      { name: "staging", waves: [{ name: "net", runs: [{ target: "network" }] }, { name: "apps", runs: [{ target: "app" }] }], ...stage },
      { name: "prod", waves: [{ name: "all", runs: [{ target: "network" }, { target: "app" }] }] },
    ],
  });

describe("github: the replan step (chant#5345)", () => {
  test("a pipeline renders the same files with replanDependents set or unset, and the stage spec its wave jobs read carries it", async () => {
    const unset = await generatePipeline(pipeline({}), "github", {}, githubPlugin);
    const set = await generatePipeline(pipeline({ replanDependents: ["network"] }), "github", {}, githubPlugin);
    expect(unset.success).toBe(true);
    expect(set.files).toEqual(unset.files);
    const yaml = unset.files!.map((f) => f.yaml).join("\n");
    expect(yaml).toContain(`"pipeline","spec","--stage","staging"`);
    expect(yaml).toContain("run wave --spec .chant/op-waves/deliver-staging.spec.json --wave 1 --render-spec");
    expect(stageWavesSpec(pipeline({ replanDependents: ["network"] }), "staging").replanDependents).toEqual(["network"]);
    expect(stageWavesSpec(pipeline({}), "staging").replanDependents).toBeUndefined();
  });

  test("an op-waves spec renders the same files with replanDependents set or unset", () => {
    const spec: OpWavesSpec = { name: "up", op: "up", step: { kind: "pulumi-up", stack: "{target}" }, waves: [{ name: "w", runs: [{ target: "network" }] }] };
    const render = (s: OpWavesSpec) => githubPlugin.generateOpWavesPipeline!(s, { specFile: ".chant/op-waves/up.spec.json" });
    expect(render({ ...spec, replanDependents: ["network"] }).files).toEqual(render(spec).files);
  });
});
