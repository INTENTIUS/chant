/**
 * #5022: the Op waves workflow keeps a product's own names on Forgejo. The
 * defaults render as they did before the options (the `default` goldens
 * were written from main before #5022), on a push pipeline and before
 * merge, each with wide waves, job groups and a rest wave.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import type { OpWavesJobRef } from "@intentius/chant/op/op-waves-names";
import { buildForgejoOpWavesDoc, generateForgejoOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec = {
  name: "tf-apply",
  op: "tf-apply",
  planWave: ["terragucci", "plan-wave", "{runs}", "{plans}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  notify: { slack: "SLACK_WEBHOOK" },
  holds: { policy: true },
  control: { repo: "codeberg.org/acme/control", op: "deploy", member: "network", tokenSecret: "TG_CONTROL_TOKEN" },
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
  staleNotes: { command: "terragucci chant components pr-post --stale --forge forgejo", env: { GITHUB_TOKEN: "${{ github.token }}" } },
  waveJobs: { canary: report("canary"), wide: report("wide"), regions: report("regions"), rest: report("rest") },
};
const beforeMerge = { ...push, beforeMerge: { merge: "auto" as const, mergeTokenSecret: "TG_MERGE_TOKEN" } };

/** terragucci's names, as `.forgejo/workflows/terragucci.yml` has them (the GitHub names test says which). */
const terragucciJob = (j: OpWavesJobRef): string | undefined => {
  const w = j.rest ? "apply-rest" : `apply-wave-${j.wave}`;
  const part = `${j.group !== undefined ? `-${j.group}` : ""}${j.share !== undefined ? `-share-${j.share}` : ""}`;
  if (j.role === "wave" || j.role === "decide") return w;
  if (j.role === "share" || j.role === "group" || j.role === "apply") return `${w}${part}`;
  if (j.role === "plan" || j.role === "gate" || j.role === "record") return `${w}-${j.role}`;
  if (j.role === "apply-status") return j.wave === spec.waves.length ? "apply-done" : `${w}-status`;
  if (j.role === "before-merge-done") return "pr-merge";
  if (j.role === "control") return "control";
  return undefined;
};
const DEFAULT_BRANCH = "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)";
const names = {
  workflowFile: "terragucci.yml",
  jobNames: terragucciJob,
  artifactNames: { outcome: "terragucci-report-{job}-outcome", decision: "terragucci-wave-{wave}", plan: "terragucci-plan-wave-{wave}", checks: "terragucci-checks-{job}", earlier: "terragucci-report-apply-wave-*" },
  runIf: DEFAULT_BRANCH,
  dispatchInputs: { pr: "apply_pr", head: "apply_head", digest: "apply_digest", wave: "apply_wave", commit: "apply_commit" },
};

type Step = { name?: string; env?: Record<string, string>; run?: string; with?: Record<string, unknown> };
type Job = { needs?: string[]; if?: string; env?: Record<string, string>; steps: Step[] };

describe("the Op waves workflow's names on Forgejo (#5022)", () => {
  test("the defaults render as before", async () => {
    await expect(generateForgejoOpWavesPipeline(spec, push).files[0]!.yaml).toMatchFileSnapshot("./__golden__/op-waves-names-default.forgejo.yml");
    await expect(generateForgejoOpWavesPipeline(spec, beforeMerge).files[0]!.yaml).toMatchFileSnapshot("./__golden__/op-waves-names-default-before-merge.forgejo.yml");
  });

  test("terragucci's names on a push, inside terragucci.yml", async () => {
    const result = generateForgejoOpWavesPipeline(spec, { ...push, ...names });
    await expect(result.files[0]!.yaml).toMatchFileSnapshot("./__golden__/op-waves-names.forgejo.yml");
    expect(result.files[0]!.name).toBe("terragucci.yml");
    const jobs = buildForgejoOpWavesDoc(spec, { ...push, ...names }).doc.jobsDoc as Record<string, Job>;
    expect(Object.keys(jobs).filter((n) => !n.endsWith("-evidence"))).toEqual(["apply-wave-1", "apply-wave-2", "apply-wave-2-share-1", "apply-wave-2-share-2", "apply-wave-3", "apply-wave-3-east", "apply-wave-3-west-share-1", "apply-wave-3-west-share-2", "apply-rest", "control", "apply-wave-1-status", "apply-wave-2-status", "apply-wave-3-status", "apply-done", "stale-notes"]);
    expect(jobs["apply-wave-2-share-1"]!.steps.find((s) => s.name === "Keep the apply report")!.with).toMatchObject({ name: "terragucci-report-apply-wave-2-share-1" });
    // Forgejo's download takes no pattern: a wave job downloads every artifact of the run.
    expect(jobs["apply-wave-2"]!.steps.find((s) => s.name === "Download the earlier jobs' outcomes")!.with).toEqual({ path: ".chant/op-waves/tf-apply/outcomes" });
    expect(jobs["apply-wave-1"]!.if).toBe(`\${{ (github.event_name == 'push' && (${DEFAULT_BRANCH})) }}`);
  });

  test("terragucci's names before merge: the follow-on dispatches terragucci.yml with its inputs", async () => {
    const options = { ...beforeMerge, ...names };
    await expect(generateForgejoOpWavesPipeline(spec, options).files[0]!.yaml).toMatchFileSnapshot("./__golden__/op-waves-names-before-merge.forgejo.yml");
    const jobs = buildForgejoOpWavesDoc(spec, options).doc.jobsDoc as Record<string, Job>;
    expect(jobs["pr-merge"]!.needs).toEqual(["apply-rest-record"]);
    // The gate job takes the plan job's files back from its outputs, under the plan job's product name.
    expect(jobs["apply-wave-2-gate"]!.steps.some((s) => s.run?.includes("needs.apply-wave-2-plan.outputs") || s.run?.includes("apply-wave-2-plan"))).toBe(true);
    const start = jobs["apply-rest-record"]!.steps.find((s) => s.env?.CHANT_WAVES_FOLLOW_ON)!;
    expect(JSON.parse(start.env!.CHANT_WAVES_FOLLOW_ON!)).toEqual({ forge: "forgejo", workflow: "terragucci.yml", inputs: names.dispatchInputs });
    expect(generateForgejoOpWavesPipeline(spec, options).files[0]!.yaml).not.toMatch(/github\.event\.inputs\.(pr|head|digest|wave|commit)\b/);
  });
});
