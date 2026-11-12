/**
 * #5022: the Op waves pipeline keeps a product's own names on GitLab. The
 * defaults render as they did before the options (the `default` goldens
 * were written from main before #5022), on a push pipeline and before
 * merge, each with wide waves, job groups and a rest wave.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { generateGitlabOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec = {
  name: "tf-apply",
  op: "tf-apply",
  planWave: ["terragucci", "plan-wave", "{runs}", "{plans}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  holds: { policy: true },
  control: { repo: "gitlab.com/acme/control", op: "deploy", member: "network", tokenSecret: "TG_CONTROL_TOKEN" },
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
  staleNotes: { command: "terragucci chant components pr-post --stale --forge gitlab", env: {} },
  waveJobs: { canary: report("canary"), wide: report("wide"), regions: report("regions"), rest: report("rest") },
};
const beforeMerge = { ...push, beforeMerge: { merge: "auto" as const, mergeTokenSecret: "TG_MERGE_TOKEN" } };

describe("the Op waves pipeline's names on GitLab (#5022)", () => {
  test("the defaults render as before", async () => {
    await expect(generateGitlabOpWavesPipeline(spec, push).files[0]!.yaml).toMatchFileSnapshot("./__golden__/op-waves-names-default.gitlab.yml");
    await expect(generateGitlabOpWavesPipeline(spec, beforeMerge).files[0]!.yaml).toMatchFileSnapshot("./__golden__/op-waves-names-default-before-merge.gitlab.yml");
  });
});
