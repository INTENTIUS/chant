/**
 * #5022: the Op waves workflow keeps a product's own names. The defaults
 * render as they did before the options (the `default` goldens were written
 * from main before #5022), on a push pipeline and before merge, each with
 * wide waves, job groups and a rest wave.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import type { OpWavesJobRef } from "@intentius/chant/op/op-waves-names";
import { buildGithubOpWavesDoc, generateGithubOpWavesPipeline } from "./generate-op-waves-pipeline";

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

/**
 * terragucci's names, as `.github/workflows/terragucci.yml` has them: a
 * wave's job (and a wide wave's deciding job) `apply-wave-<k>`, its shares
 * `apply-wave-<k>-share-<n>`, its groups `apply-wave-<k>-<group>`, the rest
 * wave `apply-rest`, the last wave's status `apply-done`, and the merge
 * after a before-merge run `pr-merge`.
 */
const terragucciJob = (j: OpWavesJobRef): string | undefined => {
  const w = j.rest ? "apply-rest" : `apply-wave-${j.wave}`;
  const part = `${j.group !== undefined ? `-${j.group}` : ""}${j.share !== undefined ? `-share-${j.share}` : ""}`;
  switch (j.role) {
    case "wave":
    case "decide":
      return w;
    case "share":
    case "group":
    case "apply":
      return `${w}${part}`;
    case "plan":
    case "gate":
    case "record":
      return `${w}-${j.role}`;
    case "apply-status":
      return j.wave === spec.waves.length ? "apply-done" : `${w}-status`;
    case "before-merge-done":
      return "pr-merge";
    case "control":
      return "control";
    default:
      return undefined;
  }
};
const DEFAULT_BRANCH = "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)";
const names = {
  workflowFile: "terragucci.yml",
  jobNames: terragucciJob,
  artifactNames: { outcome: "terragucci-report-{job}-outcome", decision: "terragucci-wave-{wave}", plan: "terragucci-plan-wave-{wave}", checks: "terragucci-checks-{job}", earlier: "terragucci-report-apply-wave-*" },
  runIf: DEFAULT_BRANCH,
  dispatchInputs: { pr: "apply_pr", head: "apply_head", digest: "apply_digest", wave: "apply_wave", commit: "apply_commit" },
};

type Step = { name?: string; env?: Record<string, string>; run?: string; uses?: string; with?: Record<string, unknown> };
type Job = { needs?: string[]; if?: string; env?: Record<string, string>; permissions?: Record<string, string>; steps: Step[] };

describe("the Op waves workflow's names on GitHub (#5022)", () => {
  test("the defaults render as before", async () => {
    await expect(generateGithubOpWavesPipeline(spec, push).files[0]!.yaml).toMatchFileSnapshot("./__golden__/op-waves-names-default.github.yml");
    await expect(generateGithubOpWavesPipeline(spec, beforeMerge).files[0]!.yaml).toMatchFileSnapshot("./__golden__/op-waves-names-default-before-merge.github.yml");
  });

  test("terragucci's names on a push: its jobs, artifacts and terragucci/apply inside terragucci.yml", async () => {
    const result = generateGithubOpWavesPipeline(spec, { ...push, ...names });
    await expect(result.files[0]!.yaml).toMatchFileSnapshot("./__golden__/op-waves-names.github.yml");
    expect(result.files[0]!.name).toBe("terragucci.yml");
    const { doc } = buildGithubOpWavesDoc(spec, { ...push, ...names });
    const jobs = doc.jobsDoc as Record<string, Job>;
    expect(Object.keys(jobs)).toEqual([
      "apply-wave-1",
      "apply-wave-1-evidence",
      "apply-wave-2",
      "apply-wave-2-evidence",
      "apply-wave-2-share-1",
      "apply-wave-2-share-2",
      "apply-wave-3",
      "apply-wave-3-evidence",
      "apply-wave-3-east",
      "apply-wave-3-west-share-1",
      "apply-wave-3-west-share-2",
      "apply-rest",
      "apply-rest-evidence",
      "control",
      "apply-wave-1-status",
      "apply-wave-2-status",
      "apply-wave-3-status",
      "apply-done",
      "stale-notes",
    ]);
    expect(result.jobs.map((j) => j.jobName)).toEqual(Object.keys(jobs).filter((n) => !/evidence|status|done|control|stale/.test(n)));
    expect(jobs["apply-wave-2-share-1"]!.needs).toEqual(["apply-wave-2"]);
    expect(jobs["apply-rest"]!.needs).toEqual(["apply-wave-3-east", "apply-wave-3-west-share-1", "apply-wave-3-west-share-2"]);
    expect(jobs["control"]!.needs).toEqual(["apply-rest"]);
    expect(jobs["apply-done"]!.needs).toEqual(["apply-rest"]);
    // The artifacts: terragucci's report per job, the outcome beside it, and the wave's decision.
    const step = (job: string, name: string) => jobs[job]!.steps.find((s) => s.name === name)!;
    expect(step("apply-wave-1", "Keep the apply report").with).toMatchObject({ name: "terragucci-report-apply-wave-1", path: "terragucci-report/" });
    expect(step("apply-wave-2-share-1", "Keep the apply report").with).toMatchObject({ name: "terragucci-report-apply-wave-2-share-1" });
    expect(step("apply-wave-1", "Keep the job's outcome").with).toMatchObject({ name: "terragucci-report-apply-wave-1-outcome" });
    expect(step("apply-wave-2", "Keep wave 2's decision").with).toMatchObject({ name: "terragucci-wave-2" });
    expect(step("apply-wave-2-share-1", "Download wave 2's decision").with).toMatchObject({ name: "terragucci-wave-2" });
    expect(step("apply-wave-2", "Download the earlier jobs' outcomes").with).toEqual({ pattern: "terragucci-report-apply-wave-*", path: ".chant/op-waves/tf-apply/outcomes" });
    expect(step("apply-done", "Download the waves' outcomes").with).toEqual({ path: ".chant/op-waves/tf-apply/outcomes" });
    // The evidence job signs from the job under its product name.
    expect(jobs["apply-wave-1-evidence"]!.needs).toEqual(["apply-wave-1"]);
    expect(jobs["apply-wave-1-evidence"]!.steps.at(-1)!.run).toContain("ci evidence sign --from-job apply-wave-1 ");
    expect(step("apply-wave-1-evidence", "Download the wave job's check claims").with).toMatchObject({ name: "terragucci-checks-apply-wave-1" });
    expect(step("apply-done", "Post terragucci/apply after wave 4").run).toContain("--apply-status terragucci/apply");
    // Each job runs on a push to the default branch alone, beside the product's plan jobs, with its permissions.
    for (const [name, job] of Object.entries(jobs)) {
      expect(job.if, name).toMatch(/^\$\{\{ \(?\(github\.event_name == 'push' && \(github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)\)\)/);
      expect(job.permissions, name).toBeDefined();
    }
    expect(jobs["apply-wave-1"]!.if).toBe(`\${{ (github.event_name == 'push' && (${DEFAULT_BRANCH})) }}`);
    expect(jobs["apply-wave-2"]!.if).toBe(`\${{ ((github.event_name == 'push' && (${DEFAULT_BRANCH}))) && (!cancelled()) }}`);
    expect(jobs["apply-wave-2-share-1"]!.permissions).toEqual({ contents: "write" });
    // The notify secrets are the wave jobs' own, not the product's workflow's.
    expect(doc.env).toBeUndefined();
    expect(jobs["apply-wave-1"]!.env).toMatchObject({ SLACK_WEBHOOK: "${{ secrets.SLACK_WEBHOOK }}" });
  });

  test("terragucci's names before merge: the split jobs, the merge as pr-merge, and dispatch inputs of its own", async () => {
    const options = { ...beforeMerge, ...names };
    await expect(generateGithubOpWavesPipeline(spec, options).files[0]!.yaml).toMatchFileSnapshot("./__golden__/op-waves-names-before-merge.github.yml");
    const { doc } = buildGithubOpWavesDoc(spec, options);
    const jobs = doc.jobsDoc as Record<string, Job>;
    expect(Object.keys(jobs).filter((n) => n.startsWith("apply-wave-2") || n.startsWith("apply-rest"))).toEqual([
      "apply-wave-2-plan",
      "apply-wave-2-plan-evidence",
      "apply-wave-2-gate",
      "apply-wave-2-share-1",
      "apply-wave-2-share-2",
      "apply-wave-2-record",
      "apply-rest-plan",
      "apply-rest-plan-evidence",
      "apply-rest-gate",
      "apply-rest",
      "apply-rest-record",
      "apply-wave-2-status",
    ]);
    expect(Object.keys(jobs)).toContain("pr-merge");
    expect(jobs["pr-merge"]!.needs).toEqual(["apply-rest-record"]);
    expect(jobs["apply-wave-2-share-1"]!.if).toContain("needs.apply-wave-2-gate.result == 'success'");
    expect(jobs["apply-wave-2-record"]!.needs).toEqual(["apply-wave-2-share-1", "apply-wave-2-share-2", "apply-wave-2-gate"]);
    // The inputs are terragucci's own, so a re-plan's `pr` never starts the waves.
    const on = doc.on as { workflow_dispatch: { inputs: Record<string, unknown> } };
    expect(Object.keys(on.workflow_dispatch.inputs)).toEqual(["apply_pr", "apply_head", "apply_digest", "apply_wave", "apply_commit"]);
    const yaml = generateGithubOpWavesPipeline(spec, options).files[0]!.yaml;
    expect(yaml).not.toMatch(/github\.event\.inputs\.(pr|head|digest|wave|commit)\b/);
    expect(jobs["apply-wave-1-plan"]!.env).toMatchObject({ CHANT_BEFORE_MERGE_PR: "${{ github.event.inputs.apply_pr }}", CHANT_BEFORE_MERGE_HEAD: "${{ github.event.inputs.apply_head }}" });
    expect(jobs["apply-rest"]!.env).toMatchObject({ CHANT_WAVES_WAVE: "${{ github.event.inputs.apply_wave || '4' }}", CHANT_WAVES_COMMIT: "${{ github.event.inputs.apply_commit }}" });
    const when = `(github.event_name == 'push' && (${DEFAULT_BRANCH})) || (github.event_name == 'workflow_dispatch' && github.event.inputs.apply_head != '') || (github.event_name == 'workflow_dispatch' && github.event.inputs.apply_wave != '')`;
    expect(jobs["apply-wave-1-plan"]!.if).toBe(`\${{ (${when}) && (github.event.inputs.apply_wave == '') }}`);
    expect(jobs["control"]!.if).toBe(`\${{ (${when}) && (!cancelled() && github.event.inputs.apply_head == '') }}`);
    // The rest wave's record job dispatches terragucci.yml with terragucci's inputs.
    const start = jobs["apply-rest-record"]!.steps.find((s) => s.env?.CHANT_WAVES_FOLLOW_ON)!;
    expect(JSON.parse(start.env!.CHANT_WAVES_FOLLOW_ON!)).toEqual({ forge: "github", workflow: "terragucci.yml", inputs: names.dispatchInputs });
    expect(jobs["apply-wave-2-gate"]!.steps.find((s) => s.name === "Keep wave 2's decision")!.with).toMatchObject({ name: "terragucci-wave-2" });
    expect(jobs["apply-wave-2-plan"]!.steps.find((s) => s.name === "Keep wave 2's saved plan")!.with).toMatchObject({ name: "terragucci-plan-wave-2" });
  });

  test("refuses what the workflow cannot take", () => {
    expect(() => generateGithubOpWavesPipeline(spec, { ...push, runIf: "${{ github.ref }}" })).toThrow(/runIf .* is one expression/);
    expect(() => generateGithubOpWavesPipeline(spec, { ...push, workflowFile: ".github/workflows/terragucci.yml" })).toThrow(/workflow file's name/);
    expect(() => generateGithubOpWavesPipeline(spec, { ...push, jobNames: (j) => (j.role === "apply-status" || j.role === "wave" ? "apply-wave-1" : undefined) })).toThrow(/names two jobs apply-wave-1/);
    expect(() => generateGithubOpWavesPipeline(spec, { ...beforeMerge, dispatchInputs: { pr: "head" } })).toThrow(/names two inputs head/);
  });
});
