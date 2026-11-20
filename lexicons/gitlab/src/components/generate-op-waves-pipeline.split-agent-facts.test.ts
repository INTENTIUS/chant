/**
 * #5406 on GitLab: a before-merge pipeline's split jobs carry the failed-apply
 * facts' variables (#5357). The summary's settings (#5335) already reached the
 * gate and record jobs, the jobs that respond for a wave: the plan and apply
 * jobs return before they respond.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGitlabOpWavesPipeline } from "./generate-op-waves-pipeline";

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

type Job = { variables?: Record<string, unknown> };
const yamlOf = (s: OpWavesSpec, o: Record<string, unknown> = {}) => generateGitlabOpWavesPipeline(s, { ...options, ...o } as never).files[0]!.yaml;
const docOf = (s: OpWavesSpec, o: Record<string, unknown> = {}) => parseYAML(yamlOf(s, o)) as Record<string, Job>;

describe("split jobs with agentFacts on GitLab (#5406)", () => {
  const doc = docOf(spec, { agentFacts: { relayKeyEnv: "OPS_RELAY" } });

  test("the gate and record jobs turn the facts on and name the relay key's variable", () => {
    for (const name of ["wave-1-dev-gate", "wave-1-dev-record", "wave-2-prod-gate", "wave-2-prod-record"]) {
      expect(doc[name]!.variables, name).toMatchObject({ CHANT_AGENT_FACTS: "apply-failed", CHANT_RELAY_KEY: "$OPS_RELAY" });
    }
  });

  test("the plan and apply jobs hold neither the facts nor the summary's settings", () => {
    for (const name of ["wave-1-dev-plan", "wave-1-dev", "wave-2-prod-plan", "wave-2-prod"]) expect(JSON.stringify(doc[name]!.variables), name).not.toMatch(/CHANT_RELAY_KEY|CHANT_AGENT_FACTS|CHANT_WAVE_SUMMARY/);
  });

  test("the summary's settings were already on the gate and record jobs", () => {
    for (const name of ["wave-1-dev-gate", "wave-1-dev-record"]) expect(doc[name]!.variables, name).toMatchObject({ CHANT_WAVE_SUMMARY_MAX_RUNS: "3" });
  });
});

describe("split jobs with neither setting on GitLab (#5406)", () => {
  test("render as before: no facts, no summary, and the same text with the option left undefined", () => {
    const base = yamlOf(plain);
    expect(base).not.toMatch(/CHANT_AGENT_FACTS|CHANT_RELAY_KEY|CHANT_WAVE_SUMMARY/);
    expect(yamlOf(plain, { agentFacts: undefined })).toBe(base);
  });
});
