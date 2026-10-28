import { describe, expect, test } from "vitest";
import { componentWaveOutputsFile, componentWaveSteps, componentWavesSpec, productDriftAgent, productPipelineJobs, productWavesSpec } from "./product-pipeline";
import { prApplyComment, prLoopSetup, PR_LOOP_IMAGE, PR_LOOP_SETUP, withProductBin } from "./pr-pipeline";
import { PLYWOOD, TERRAGUCCI } from "../__fixtures__/product-words";
import type { OpWavesSpec } from "../op/op-waves";

const waves: OpWavesSpec = {
  name: "apply",
  op: "apply",
  planWave: ["chant", "components", "plan-wave", "{runs}", "{plans}"],
  applyWave: ["chant", "components", "apply-wave", "{runs}", "{plans}"],
  waves: [
    { name: "dev", runs: [{ target: "shop-dev" }] },
    { name: "prod", runs: [{ target: "shop-prod" }] },
  ],
};

describe("the product pipeline (#4550)", () => {
  test("terragucci's and plywood's jobs differ only in the words each passes", () => {
    const tg = productPipelineJobs("github", "production", { words: TERRAGUCCI, waves, applyBeforeMerge: false, locks: "plan", agent: true });
    const pw = productPipelineJobs("github", "production", { words: PLYWOOD, waves, locks: "plan" });
    const shape = (j: typeof tg) => ({ plan: Object.keys(j.plan.env).sort(), waves: j.waves!.jobs.map((w) => w.jobName) });
    expect(shape(tg)).toEqual(shape(pw));
    expect(tg.waves!.spec.name).toBe("tf-apply");
    expect(pw.waves!.spec.name).toBe("pulumi-up");
    expect(tg.waves!.spec.gateName).toBe("wave-{k}");
    expect(pw.waves!.spec.gateName).toBe("wave-{k}");
  });

  test("the plan side runs the product's bin, and ci run passes it on", () => {
    const pw = productPipelineJobs("github", "production", { words: PLYWOOD });
    expect(pw.plan.command.startsWith("npx --no-install plywood components pr-plan ")).toBe(true);
    expect(pw.plan.command).toContain("--gate up");
    expect(pw.plan.run.command.startsWith('npx --no-install plywood ci run plan --chant "npx --no-install plywood" --in-place')).toBe(true);
    expect(pw.post.command.startsWith("npx --no-install plywood components pr-post ")).toBe(true);
    expect(pw.record).toBeDefined();
    expect(pw.waves).toBeUndefined();
  });

  test("the apply on merge runs on op waves through the product's bin", () => {
    const pw = productPipelineJobs("github", "production", { words: PLYWOOD, waves });
    expect(pw.record).toBeUndefined();
    expect(pw.waves!.specFile).toBe(".chant/op-waves/pulumi-up.spec.json");
    expect(pw.waves!.jobs[0]!.command.slice(0, 6)).toEqual(["npx", "--no-install", "plywood", "run", "wave", "--spec"]);
    expect(pw.comments).toEqual({ apply: "/plywood up" });
  });

  test("the approval preset: per wave for terragucci, the pull request's digest for plywood", () => {
    const tg = productWavesSpec(waves, TERRAGUCCI);
    expect(tg.waves.every((w) => w.approval === undefined)).toBe(true);
    expect(tg.approvals?.pullRequest).toBeUndefined();
    const pw = productWavesSpec(waves, PLYWOOD);
    expect(pw.waves.every((w) => w.approval === "pull-request")).toBe(true);
    expect(pw.approvals?.pullRequest).toEqual({ gate: "up" });
  });

  test("the words the jobs carry take the apply mode the jobs build (#4601)", () => {
    expect(productPipelineJobs("github", "production", { words: PLYWOOD, waves }).words.applyMode).toBe("on-merge");
    expect(productPipelineJobs("github", "production", { words: PLYWOOD }).words.applyMode).toBe("release");
    expect(productPipelineJobs("github", "production", { words: PLYWOOD, applyBeforeMerge: true }).words.applyMode).toBe("before-merge");
    expect(productPipelineJobs("github", "production", { words: { ...PLYWOOD, applyMode: "before-merge" }, waves, applyBeforeMerge: true }).words.applyMode).toBe("before-merge");
    expect(productPipelineJobs("github", "production", { words: { ...PLYWOOD, applyMode: "before-merge" }, waves }).words.applyMode).toBe("on-merge");
  });

  test("a command with no job is refused", () => {
    expect(() => productPipelineJobs("github", "production", { words: TERRAGUCCI })).toThrow(/needs a apply job/);
  });

  test("the component graph gives the waves pr-apply --wave-gate runs on op waves", () => {
    const spec = componentWavesSpec(
      [{ name: "net", dependsOn: [] }, { name: "app", dependsOn: ["net"] }],
      PLYWOOD,
      { planWave: ["chant", "components", "plan-wave", "{runs}", "{plans}"], applyWave: ["chant", "components", "apply-wave", "{runs}", "{plans}"] },
    );
    expect(spec.name).toBe("pulumi-up");
    expect(spec.waves.map((w) => w.runs.map((r) => r.target))).toEqual([["net"], ["app"]]);
  });

  test("the comment, the bin and the engine lines", () => {
    expect(prApplyComment()).toBe("/chant apply");
    expect(prApplyComment({ words: PLYWOOD })).toBe("/plywood up");
    expect(withProductBin('git fetch && GREEN_SHA="$(chant ci last-green)"', "npx plywood")).toBe('git fetch && GREEN_SHA="$(npx plywood ci last-green)"');
    expect(withProductBin("chant/lifecycle stays", "npx plywood")).toBe("chant/lifecycle stays");
    expect(prLoopSetup(PR_LOOP_IMAGE)).toEqual(PR_LOOP_SETUP);
    expect(prLoopSetup(PR_LOOP_IMAGE, ["install pulumi"])).toEqual(["install pulumi"]);
    expect(prLoopSetup("my/image", ["install pulumi"])).toEqual([]);
  });
});

describe("pr-apply --wave-gate on op waves (#4588)", () => {
  const graph = [{ name: "net", dependsOn: [] }, { name: "app", dependsOn: ["net"] }];

  test("the component plan-wave and apply-wave steps name the runs, the plans, the base and the outputs file", () => {
    const steps = componentWaveSteps({ bin: "npx --no-install plywood", env: "prod", base: "abc123", member: "infra", op: "pr-7", gate: "up" });
    expect(steps.planWave).toEqual(["npx", "--no-install", "plywood", "components", "plan-wave", "--runs", "{runs}", "--plans", "{plans}", "--env", "prod", "--base", "abc123", "--member", "infra", "--gate", "up", "--wave-outputs", componentWaveOutputsFile("pr-7")]);
    expect(steps.applyWave.slice(0, 5)).toEqual(["npx", "--no-install", "plywood", "components", "apply-wave"]);
    expect(componentWaveSteps({ env: "prod", base: "HEAD^1", op: "x" }).planWave[0]).toBe("chant");
  });

  test("under the pull request's op every wave takes its approval, whatever the words' preset", () => {
    const steps = componentWaveSteps({ env: "prod", base: "abc", op: "pr-7" });
    const spec = componentWavesSpec(graph, TERRAGUCCI, steps, { op: "pr-7", gate: "apply", prGate: "pr-apply" });
    expect(spec.name).toBe("pr-7");
    expect(spec.op).toBe("pr-7");
    expect(spec.waves.every((w) => w.approval === "pull-request")).toBe(true);
    expect(spec.approvals?.pullRequest).toEqual({ gate: "pr-apply" });
    expect(spec.planWave).toEqual(steps.planWave);
  });

  test("the layers a derivation already has are kept", () => {
    const spec = componentWavesSpec(graph, PLYWOOD, componentWaveSteps({ env: "prod", base: "abc", op: "pr-7" }), { op: "pr-7", waves: [["net", "app"]] });
    expect(spec.waves.map((w) => w.runs.map((r) => r.target))).toEqual([["net", "app"]]);
  });

  test("productPipelineJobs takes the component graph's waves when the product has no spec of its own", () => {
    const jobs = productPipelineJobs("github", "production", { words: PLYWOOD, componentWaves: { components: graph } });
    expect(jobs.waves!.spec.name).toBe("pulumi-up");
    expect(jobs.waves!.spec.planWave!.slice(3, 5)).toEqual(["components", "plan-wave"]);
    expect(jobs.waves!.spec.planWave).toContain("HEAD^1");
    expect(jobs.waves!.jobs.map((j) => j.jobName)).toEqual(["wave-1-wave-1", "wave-2-wave-2"]);
    expect(jobs.waves!.jobs[0]!.command.slice(0, 3)).toEqual(["npx", "--no-install", "plywood"]);
  });
});

describe("the lock and unlock comments (#4588)", () => {
  test("productPipelineJobs gives a job per comment under locks: plan, on each forge", () => {
    for (const forge of ["github", "forgejo", "gitlab"] as const) {
      const jobs = productPipelineJobs(forge, "production", { words: PLYWOOD, waves, locks: "plan" });
      expect(jobs.locks!.map((j) => [j.jobName, j.comment])).toEqual([["comment-lock", "/plywood lock"], ["comment-unlock", "/plywood unlock"]]);
      expect(jobs.locks![0]!.line).toBe(`npx --no-install plywood lock --keep --pr "$PR_NUMBER" --forge ${forge}`);
      expect(jobs.locks![1]!.line).toBe('npx --no-install plywood unlock --pr "$PR_NUMBER"');
    }
    const gitlab = productPipelineJobs("gitlab", "production", { words: PLYWOOD, waves, locks: "plan" });
    expect(gitlab.locks![0]!.env).toEqual({ PR_NUMBER: "$CHANT_LOCK_PR" });
    expect(gitlab.locks![0]!.gitlabVar).toBe("CHANT_LOCK_PR");
  });

  test("no comment jobs without locks: plan", () => {
    expect(productPipelineJobs("github", "production", { words: PLYWOOD, waves }).locks).toBeUndefined();
  });
});

describe("the agent (#4616)", () => {
  const words = { ...PLYWOOD, commands: { ...PLYWOOD.commands, agent: "agent" as const } };

  test("returns the agent's Op spec for its comment, with the settings checked", () => {
    const pw = productPipelineJobs("github", "production", { words, agent: { maxRuns: 5, timeout: 20, keyEnv: "MODEL_KEY", runner: "agents" } });
    expect(pw.agent?.comment).toBe("/plywood agent");
    expect(pw.agent?.spec).toEqual({
      name: "plywood-agent",
      trigger: { kind: "pull_request" },
      agent: { on: "comment", comment: "/plywood agent", maxRuns: 5, timeout: 20, keyEnv: "MODEL_KEY" },
      runner: "agents",
    });
    expect(() => productPipelineJobs("github", "production", { words, agent: { timeout: 0 } })).toThrow(/timeout/);
  });

  test("a product whose words name no agent command gets no agent", () => {
    expect(productPipelineJobs("github", "production", { words: PLYWOOD, agent: true }).agent).toBeUndefined();
    expect(productPipelineJobs("github", "production", { words: PLYWOOD }).agent).toBeUndefined();
  });

  test("the drift agent of a scheduled drift Op", () => {
    expect(productDriftAgent(words, "plywood-drift-app", { maxRuns: 2 })).toEqual({ on: "drift", maxRuns: 2 });
    expect(() => productDriftAgent(words, "plywood-drift-app", { branch: "../x" })).toThrow(/branch/);
  });
});

