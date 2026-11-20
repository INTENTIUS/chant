/**
 * The product helpers' risk and replan keys, and the job image and install
 * lines the pipeline generator hands the promote jobs (#5425).
 */
import { describe, expect, test } from "vitest";
import { generatePipeline } from "./generate";
import { pipelineFromConfig, pipelineSource } from "./product";
import { foldPipelineSource } from "./fold";
import { asPipelineSpec } from "./spec";
import { PIPELINE_PRODUCT_JOBS_FLOOR } from "../pipeline";
import { NEXT_RELEASE } from "../release-floors";

const wave = (name: string) => ({ name, runs: [{ target: name }] });
const waves = { dev: [wave("dev")], staging: [wave("staging")], prod: [wave("prod")] };

const config = {
  name: "shop",
  promotion: ["dev", "staging", "prod"],
  defaults: { op: "shop", replanDependents: ["db/*"] },
  waves,
  environments: {
    dev: { risk: { approve_above: 0.6 } },
    staging: { replan_dependents: ["network/**", "db/*"] },
    prod: {
      risk: { approve_above: 0.4, approval_rules: [{ count: 1, roles: ["sre"], not_author: true }] },
      replanDependents: ["app/*"],
    },
  },
};

describe("pipelineFromConfig maps risk and replan_dependents", () => {
  const declaration = pipelineFromConfig(config);
  const stage = (name: string) => declaration.stages.find((s) => s.name === name)!;

  test("risk lands on the gate's holds.risk, snake_case or camelCase", () => {
    expect(stage("dev").gate).toEqual({ holds: { risk: { approveAbove: 0.6 } } });
    expect(stage("prod").gate?.holds).toEqual({ risk: { approveAbove: 0.4, quorum: [{ count: 1, roles: ["sre"], notAuthor: true }] } });
    expect(pipelineFromConfig({ ...config, environments: { dev: { risk: { approveAbove: 0.2 } } } }).stages[0]!.gate?.holds).toEqual({ risk: { approveAbove: 0.2 } });
  });

  test("risk keeps the gate's other keys", () => {
    const out = pipelineFromConfig({ ...config, gate: "always", environments: { dev: { risk: { approve_above: 0.5 } } } });
    expect(out.stages[0]!.gate).toEqual({ policy: "always", holds: { risk: { approveAbove: 0.5 } } });
  });

  test("replan_dependents lands on the stage, and the pipeline's defaults stay", () => {
    expect(stage("staging").replanDependents).toEqual(["network/**", "db/*"]);
    expect(stage("prod").replanDependents).toEqual(["app/*"]);
    expect(stage("dev").replanDependents).toBeUndefined();
    expect(declaration.defaults?.replanDependents).toEqual(["db/*"]);
  });

  test("a risk hold takes rules, and a group is refused", () => {
    expect(() => pipelineFromConfig({ ...config, environments: { prod: { risk: { approval_rules: [{ all: [{ count: 1 }] }] } } } })).toThrow(/risk hold takes rules only/);
  });

  test("a stage with neither key is as before", () => {
    const plain = pipelineFromConfig({ name: "shop", promotion: ["dev"], waves });
    expect(plain.stages[0]).toEqual({ name: "dev", waves: [wave("dev")] });
  });

  test("the written file folds back to the declaration", () => {
    const text = pipelineSource(declaration, { product: "plywood", config: "plywood.yml", command: "plywood ci" });
    const folded = foldPipelineSource(text, ".chant/pipeline.ts");
    expect("finding" in folded).toBe(false);
    expect(folded).toMatchObject({ stages: expect.arrayContaining([expect.objectContaining({ name: "prod", replanDependents: ["app/*"] })]) });
  });
});

describe("the pipeline generator hands the promote jobs the product's image and install lines", () => {
  const spec = asPipelineSpec(pipelineFromConfig({ name: "shop", promotion: ["dev", "staging", "prod"], waves }));
  const capture = () => {
    const promotes: Array<Record<string, unknown>> = [];
    const plugin = {
      generateOpWavesPipeline: () => ({ files: [], jobs: [] }),
      generatePipelinePromote: (i: Record<string, unknown>) => (promotes.push(i), []),
    } as never;
    return { promotes, plugin };
  };

  test("image and beforeScript reach the promote input", async () => {
    const { promotes, plugin } = capture();
    await generatePipeline(spec, "github", { image: "ghcr.io/intentius/plunge:1", beforeScript: ["npm ci"] }, plugin);
    expect(promotes[0]).toMatchObject({ image: "ghcr.io/intentius/plunge:1", beforeScript: ["npm ci"] });
  });

  test("with neither, the input has neither key", async () => {
    const { promotes, plugin } = capture();
    await generatePipeline(spec, "github", { beforeScript: [] }, plugin);
    expect(promotes[0]).not.toHaveProperty("image");
    expect(promotes[0]).not.toHaveProperty("beforeScript");
  });
});

test("the floor names the next release", () => {
  expect(PIPELINE_PRODUCT_JOBS_FLOOR).toBe(NEXT_RELEASE);
});
