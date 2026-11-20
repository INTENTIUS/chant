/**
 * #5406 on Github: a before-merge pipeline's split jobs carry the failed-apply
 * facts' settings (#5357). The summary's settings (#5335) already reached the
 * gate and record jobs, the jobs that respond for a wave: the plan and apply jobs
 * return before they respond, so the relay key stays off the jobs that run the
 * change's code.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGithubOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec = {
  name: "tf-apply",
  op: "tf-apply",
  plan: ["terragucci", "plan", "{target}", "--out", "{plan}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  respond: { "wave-refused": "summary" },
  waveSummary: { maxRuns: 3 },
  waves: [{ name: "dev", runs: [{ target: "dev" }] }, { name: "prod", runs: [{ target: "prod" }] }],
} as OpWavesSpec;
const plain = { ...spec, respond: undefined, waveSummary: undefined } as OpWavesSpec;
const options = { specFile: ".chant/op-waves/tf-apply.spec.json", bin: "terragucci", beforeMerge: { merge: "manual" as const } };

type Step = { name?: string; env?: Record<string, string>; run?: string };
type Job = { env?: Record<string, string>; steps: Step[] };
const jobsOf = (s: OpWavesSpec, o: Record<string, unknown> = {}) => (parseYAML(generateGithubOpWavesPipeline(s, { ...options, ...o } as never).files[0]!.yaml) as { jobs: Record<string, Job> }).jobs;
const yamlOf = (s: OpWavesSpec, o: Record<string, unknown> = {}) => generateGithubOpWavesPipeline(s, { ...options, ...o } as never).files[0]!.yaml;
const envText = (job: Job) => JSON.stringify([job.env ?? {}, ...job.steps.map((s) => s.env ?? {})]);

describe("split jobs with agentFacts on Github (#5406)", () => {
  const jobs = jobsOf(spec, { agentFacts: { relayKeyEnv: "OPS_RELAY" } });

  test("the gate and record jobs' command step turns the facts on and holds the relay key", () => {
    for (const name of ["wave-1-dev-gate", "wave-1-dev-record", "wave-2-prod-gate", "wave-2-prod-record"]) {
      const step = jobs[name]!.steps.find((s) => s.env?.CHANT_AGENT_FACTS !== undefined);
      expect(step?.env, name).toMatchObject({ CHANT_AGENT_FACTS: "apply-failed", CHANT_RELAY_KEY: "${{ secrets.OPS_RELAY }}" });
      expect(step!.run, name).toContain("--phase");
    }
  });

  test("the plan and apply jobs, which run the change's code, hold neither the relay key nor the facts", () => {
    for (const name of ["wave-1-dev-plan", "wave-1-dev", "wave-2-prod-plan", "wave-2-prod"]) expect(envText(jobs[name]!), name).not.toMatch(/CHANT_RELAY_KEY|CHANT_AGENT_FACTS/);
  });

  test("the summary's settings were already on the gate and record jobs, and stay off the plan and apply jobs", () => {
    for (const name of ["wave-1-dev-gate", "wave-1-dev-record"]) expect(jobs[name]!.env, name).toMatchObject({ CHANT_WAVE_SUMMARY_MAX_RUNS: "3", ANTHROPIC_API_KEY: "${{ secrets.ANTHROPIC_API_KEY }}" });
    for (const name of ["wave-1-dev-plan", "wave-1-dev"]) expect(envText(jobs[name]!), name).not.toContain("CHANT_WAVE_SUMMARY");
  });
});

describe("split jobs with neither setting on Github (#5406)", () => {
  test("render as before: no facts, no summary, and the same text with the options left undefined", () => {
    const base = yamlOf(plain);
    expect(base).not.toMatch(/CHANT_AGENT_FACTS|CHANT_RELAY_KEY|CHANT_WAVE_SUMMARY/);
    expect(yamlOf(plain, { agentFacts: undefined })).toBe(base);
  });

  test("agentFacts adds the two variables to the gate and record jobs and changes nothing else", () => {
    const withFacts = jobsOf(spec, { agentFacts: {} });
    for (const job of Object.values(withFacts)) for (const step of job.steps) if (step.env) { delete step.env.CHANT_AGENT_FACTS; delete step.env.CHANT_RELAY_KEY; if (Object.keys(step.env).length === 0) delete step.env; }
    expect(withFacts).toEqual(jobsOf(spec, {}));
  });
});
