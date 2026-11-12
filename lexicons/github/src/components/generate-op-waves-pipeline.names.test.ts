/**
 * #5022: the Op waves workflow keeps a product's own names. The defaults
 * render as they did before the options (the `default` goldens were written
 * from main before #5022), on a push pipeline and before merge, each with
 * wide waves, job groups and a rest wave.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { generateGithubOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec = {
  name: "tf-apply",
  op: "tf-apply",
  planWave: ["terragucci", "plan-wave", "{runs}", "{plans}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  notify: { slack: "SLACK_WEBHOOK" },
  holds: { policy: true },
  control: { repo: "github.com/acme/control", op: "deploy", member: "network", tokenSecret: "TG_CONTROL_TOKEN" },
  waves: [
    { name: "canary", runs: [], discover: true },
    { name: "wide", runs: [], discover: true, shares: 2 },
    { name: "regions", runs: [], discover: true, jobs: [{ name: "east", runs: ["east/*"] }, { name: "west", runs: ["west/*"], shares: 2 }] },
    { name: "rest", runs: [], discover: true, rest: true },
  ],
} as unknown as OpWavesSpec;

const report = (wave: string) => ({ report: { name: "Write the apply report", run: [`terragucci report ${wave}`] }, artifact: { step: "Keep the apply report", name: "terragucci-report-{job}", path: "terragucci-report/" } });

const push = {
  specFile: ".chant/op-waves/tf-apply.spec.json",
  bin: "terragucci",
  evidence: { identity: "oidc" as const },
  applyStatus: { context: "terragucci/apply" },
  staleNotes: { command: "terragucci chant components pr-post --stale", env: { GITHUB_TOKEN: "${{ github.token }}" } },
  waveJobs: { canary: report("canary"), wide: report("wide"), regions: report("regions"), rest: report("rest") },
};
const beforeMerge = { ...push, beforeMerge: { merge: "auto" as const, mergeTokenSecret: "TG_MERGE_TOKEN" } };

describe("the Op waves workflow's names on GitHub (#5022)", () => {
  test("the defaults render as before", async () => {
    await expect(generateGithubOpWavesPipeline(spec, push).files[0]!.yaml).toMatchFileSnapshot("./__golden__/op-waves-names-default.github.yml");
    await expect(generateGithubOpWavesPipeline(spec, beforeMerge).files[0]!.yaml).toMatchFileSnapshot("./__golden__/op-waves-names-default-before-merge.github.yml");
  });
});
