/**
 * #5022: the Op waves pipeline keeps a product's own names on GitLab. The
 * defaults render as they did before the options (the `default` goldens
 * were written from main before #5022), on a push pipeline and before
 * merge, each with wide waves, job groups and a rest wave.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import type { OpWavesJobRef, OpWavesStageRef } from "@intentius/chant/op/op-waves-names";
import { parseYAML } from "@intentius/chant/yaml";
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

/**
 * terragucci's names, as `.gitlab/terragucci.yml` has them: the wave jobs
 * as on GitHub, in its one `apply` stage, the merge after a before-merge
 * pipeline `pr-merge`, and every rule joined with its own, which keeps the
 * apply jobs out of the plan notes, comments and other schedules' pipelines.
 */
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
const RUN_IF = '$CI_PIPELINE_SOURCE != "schedule" && $TERRAGUCCI_PLAN_NOTES == null';
const names = { jobNames: terragucciJob, stageNames: (s: OpWavesStageRef) => (s.role === "control" ? undefined : "apply"), runIf: RUN_IF, opsFileName: ".gitlab/terragucci.yml" };

type Job = { stage?: string; needs?: Array<string | { job: string; optional: true }>; rules?: Array<{ if: string; when?: string }>; variables?: Record<string, string>; script?: string[]; artifacts?: { name?: string } };
const docOf = (o: Record<string, unknown>) => parseYAML(generateGitlabOpWavesPipeline(spec, o as never).files[0]!.yaml) as Record<string, Job> & { stages: string[] };

describe("the Op waves pipeline's names on GitLab (#5022)", () => {
  test("the defaults render as before", async () => {
    await expect(generateGitlabOpWavesPipeline(spec, push).files[0]!.yaml).toMatchFileSnapshot("./__golden__/op-waves-names-default.gitlab.yml");
    await expect(generateGitlabOpWavesPipeline(spec, beforeMerge).files[0]!.yaml).toMatchFileSnapshot("./__golden__/op-waves-names-default-before-merge.gitlab.yml");
  });

  test("terragucci's names on a push: its jobs, its apply stage and its rules", async () => {
    const result = generateGitlabOpWavesPipeline(spec, { ...push, ...names });
    await expect(result.files[0]!.yaml).toMatchFileSnapshot("./__golden__/op-waves-names.gitlab.yml");
    expect(result.files[0]!.name).toBe(".gitlab/terragucci.yml");
    const doc = docOf({ ...push, ...names });
    expect(doc.stages).toEqual(["apply", "control"]);
    expect(Object.keys(doc).filter((k) => k !== "stages")).toEqual([
      "apply-wave-1-policy",
      "apply-wave-1",
      "apply-wave-1-evidence",
      "apply-wave-2-policy",
      "apply-wave-2",
      "apply-wave-2-evidence",
      "apply-wave-2-share-1",
      "apply-wave-2-share-2",
      "apply-wave-3-policy",
      "apply-wave-3",
      "apply-wave-3-evidence",
      "apply-wave-3-east",
      "apply-wave-3-west-share-1",
      "apply-wave-3-west-share-2",
      "apply-rest-policy",
      "apply-rest",
      "apply-rest-evidence",
      "apply-wave-1-status",
      "apply-wave-2-status",
      "apply-wave-3-status",
      "apply-done",
      "stale-notes",
      "control",
    ]);
    expect(doc["apply-wave-2"]!.needs).toEqual(["apply-wave-1", "apply-wave-2-policy"]);
    expect(doc["apply-wave-2-evidence"]!.needs).toEqual(["apply-wave-2", "apply-wave-2-policy"]);
    expect(JSON.parse(doc["apply-wave-2-evidence"]!.variables!.CHANT_EVIDENCE_SOURCES!)).toMatchObject({ "policy:wide": { job: "apply-wave-2-policy" } });
    expect(doc["apply-wave-2-evidence"]!.script!.join("\n")).toContain("--from-job apply-wave-2 ");
    expect(doc["apply-wave-2-share-1"]!.artifacts!.name).toBe("terragucci-report-apply-wave-2-share-1");
    expect(doc["apply-done"]!.needs).toEqual(["apply-rest"]);
    expect(doc["control"]!.needs).toEqual(["apply-rest"]);
    expect(doc["apply-done"]!.script!.join("\n")).toContain("--apply-status terragucci/apply");
    for (const [name, job] of Object.entries(doc)) {
      if (name === "stages") continue;
      for (const rule of job.rules ?? []) if (rule.when !== "never") expect(rule.if, name).toMatch(/^\(\$CI_PIPELINE_SOURCE != "schedule" && \$TERRAGUCCI_PLAN_NOTES == null\) && \(/);
    }
    expect(doc["apply-wave-1"]!.rules).toEqual([{ if: `(${RUN_IF}) && ($CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == "main")` }]);
  });

  test("terragucci's names before merge: the split jobs and pr-merge, as mr-apply's pipeline runs them", async () => {
    const options = { ...beforeMerge, ...names };
    await expect(generateGitlabOpWavesPipeline(spec, options as never).files[0]!.yaml).toMatchFileSnapshot("./__golden__/op-waves-names-before-merge.gitlab.yml");
    const doc = docOf(options);
    expect(doc.stages).toEqual(["apply", "control"]);
    expect(doc["pr-merge"]!.stage).toBe("apply");
    expect(doc["pr-merge"]!.needs).toEqual(["apply-rest-record"]);
    expect(doc["apply-wave-2-record"]!.needs).toEqual(["apply-wave-2-share-1", "apply-wave-2-share-2", "apply-wave-2-gate"]);
    expect(doc["apply-rest-plan"]!.needs).toEqual([{ job: "apply-wave-3-record", optional: true }, { job: "apply-rest-plan-policy", optional: true }]);
    // A job of a wave before the rest wave stays out of a follow-on pipeline, before the product's rule.
    expect(doc["apply-wave-1-plan"]!.rules![0]).toEqual({ if: "$CHANT_WAVES_WAVE", when: "never" });
    expect(doc["apply-wave-1-plan"]!.rules![2]!.if).toMatch(/^\(\$CI_PIPELINE_SOURCE != "schedule".*\) && \(\$CI_PIPELINE_SOURCE =~ \/\^\(web\|api\|trigger\)\$\/ && \$CHANT_BEFORE_MERGE_HEAD/);
  });

  test("refuses what a GitLab pipeline cannot take", () => {
    expect(() => generateGitlabOpWavesPipeline(spec, { ...push, workflowFile: "terragucci.yml" })).toThrow(/on GitLab the file is opsFileName/);
    expect(() => generateGitlabOpWavesPipeline(spec, { ...beforeMerge, dispatchInputs: { pr: "apply_pr" } })).toThrow(/carries the decision in variables/);
    expect(() => generateGitlabOpWavesPipeline(spec, { ...push, artifactNames: { decision: "d-{wave}" } })).toThrow(/through needs/);
    expect(() => generateGitlabOpWavesPipeline(spec, { ...push, jobNames: (j) => (j.role === "wave" ? "variables" : undefined) })).toThrow(/no GitLab keyword/);
    expect(() => generateGitlabOpWavesPipeline(spec, { ...push, stageNames: () => "a/b" })).toThrow(/not a stage name/);
  });
});
