/**
 * #5032: the Op waves pipelines as chant renders them on GitLab without
 * the options that later issues add. These goldens were written from main
 * before any of those changes, so a new option that leaves its default
 * alone keeps every byte of them: named branches, the resume job, notify,
 * the plans jobs, before merge with a rest wave, and a product's pipeline.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import type { OpWavesPipelineOptions } from "@intentius/chant/lexicon";
import { generateGitlabOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec = {
  name: "tf-apply",
  op: "tf-apply",
  planWave: ["terragucci", "plan-wave", "{runs}", "{plans}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  branches: ["main", "release"],
  standDown: true,
  resume: { schedule: "*/10 * * * *" },
  notify: { slack: "SLACK_WEBHOOK", teams: "TEAMS_WEBHOOK", relay: "RELAY_KEY" },
  holds: { policy: true },
  control: { repo: "gitlab.com/acme/control", op: "deploy", member: "network", tokenSecret: "TG_CONTROL_TOKEN" },
  waves: [
    { name: "canary", runs: [], discover: true },
    { name: "wide", runs: [], discover: true, shares: 2 },
    { name: "regions", runs: [], discover: true, jobs: [{ name: "east", runs: ["east/*"] }, { name: "west", runs: ["west/*"], shares: 2 }] },
    { name: "rest", runs: [], discover: true, rest: true },
  ],
} as unknown as OpWavesSpec;

const plansSpec = {
  name: "deploy",
  op: "deploy",
  apply: ["./apply.sh", "{target}"],
  plan: ["./plan.sh", "{target}", "{plan}"],
  branches: ["main", "release"],
  waves: [{ name: "prod", runs: [{ target: "app" }], approval: "pr-review" }],
} as unknown as OpWavesSpec;

const report = (wave: string) => ({ report: { name: "Write the apply report", run: [`terragucci report ${wave}`] }, artifact: { step: "Keep the apply report", name: "terragucci-report-{job}", path: "terragucci-report/" } });

const push: OpWavesPipelineOptions = {
  specFile: ".chant/op-waves/tf-apply.spec.json",
  bin: "terragucci",
  renderSpec: { command: ["terragucci", "waves-spec"] },
  evidence: { identity: "oidc" },
  applyStatus: { context: "terragucci/apply" },
  staleNotes: { command: "terragucci chant components pr-post --stale --forge gitlab", env: {} },
  waveJobs: { canary: report("canary"), wide: report("wide"), regions: report("regions"), rest: report("rest") },
};
const beforeMerge: OpWavesPipelineOptions = { ...push, beforeMerge: { merge: "auto", mergeTokenSecret: "TG_MERGE_TOKEN" } };
const product: OpWavesPipelineOptions = {
  ...beforeMerge,
  opsFileName: ".gitlab/terragucci.yml",
  stageNames: (s) => (s.role === "control" ? undefined : "apply"),
  runIf: '$CI_PIPELINE_SOURCE != "schedule" && $TERRAGUCCI_PLAN_NOTES == null',
};

/** Every file the generator writes, one after the other under its name. */
const rendered = (s: OpWavesSpec, options: OpWavesPipelineOptions): string =>
  generateGitlabOpWavesPipeline(s, options)
    .files.map((f) => `# file: ${f.name}\n${f.yaml}`)
    .join("\n");

describe("the Op waves pipelines' defaults on GitLab (#5032)", () => {
  test("a push pipeline with named branches, resume, notify, evidence and control", async () => {
    await expect(rendered(spec, push)).toMatchFileSnapshot("./__golden__/op-waves-defaults-push.gitlab.yml");
  });
  test("before merge, with a rest wave", async () => {
    await expect(rendered(spec, beforeMerge)).toMatchFileSnapshot("./__golden__/op-waves-defaults-before-merge.gitlab.yml");
  });
  test("in a product's pipeline", async () => {
    await expect(rendered(spec, product)).toMatchFileSnapshot("./__golden__/op-waves-defaults-product.gitlab.yml");
  });
  test("a pr-review wave's plans jobs", async () => {
    await expect(rendered(plansSpec, { specFile: ".chant/op-waves/deploy.spec.json" })).toMatchFileSnapshot("./__golden__/op-waves-defaults-plans.gitlab.yml");
  });
});
