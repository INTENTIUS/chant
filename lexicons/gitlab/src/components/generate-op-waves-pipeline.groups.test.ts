/**
 * #5053: the GitLab control job takes a product's `resource_group`, with
 * `{commit}` standing for the commit it tells the control repo about, and
 * the resume job takes one too, such as terragucci's `terragucci-control`
 * and `terragucci-resume`. Without them neither job has one (the
 * `op-waves-defaults-*` goldens), and the wave jobs never do.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import type { OpWavesPipelineOptions } from "@intentius/chant/lexicon";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGitlabOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec = {
  name: "tf-apply",
  op: "tf-apply",
  planWave: ["terragucci", "plan-wave", "{runs}", "{plans}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  resume: { schedule: "*/10 * * * *" },
  control: { repo: "github.com/org/control", op: "tf-apply", member: "net", tokenSecret: "CONTROL_TOKEN" },
  waves: [{ name: "canary", runs: [], discover: true }],
} as unknown as OpWavesSpec;
const restSpec = { ...spec, waves: [...spec.waves, { name: "rest", runs: [], discover: true, rest: true }] } as unknown as OpWavesSpec;

const base: OpWavesPipelineOptions = { specFile: "w.json", bin: "terragucci" };
type Job = { resource_group?: string; script?: string[] };
const jobsOf = (s: OpWavesSpec, o: OpWavesPipelineOptions) => {
  const doc = parseYAML(generateGitlabOpWavesPipeline(s, o).files[0]!.yaml) as Record<string, Job>;
  return Object.fromEntries(Object.entries(doc).filter(([, v]) => v && typeof v === "object" && !Array.isArray(v) && "script" in v)) as Record<string, Job>;
};

describe("the GitLab control and resume jobs' resource groups (#5053)", () => {
  test("terragucci's names on the two jobs, and none on the wave jobs", () => {
    const jobs = jobsOf(spec, { ...base, controlGroup: "terragucci-control", resumeGroup: "terragucci-resume" });
    expect(jobs["control-dispatch"]!.resource_group).toBe("terragucci-control");
    expect(jobs["tf-apply-resume"]!.resource_group).toBe("terragucci-resume");
    for (const [name, job] of Object.entries(jobs)) if (name !== "control-dispatch" && name !== "tf-apply-resume") expect(job.resource_group, name).toBeUndefined();
  });

  test("{commit} is the pushed commit, or a follow-on's CHANT_WAVES_COMMIT", () => {
    expect(jobsOf(spec, { ...base, controlGroup: "control-{commit}" })["control-dispatch"]!.resource_group).toBe("control-$CI_COMMIT_SHA");
    const follow = jobsOf(restSpec, { ...base, controlGroup: "control-{commit}", beforeMerge: { merge: "manual" } });
    expect(follow["control-dispatch"]!.resource_group).toBe("control-$CHANT_WAVES_COMMIT");
  });

  test("without them neither job has one", () => {
    for (const job of Object.values(jobsOf(spec, base))) expect(job.resource_group).toBeUndefined();
  });

  test("refused: no control or resume on the spec, an empty group, two lines", () => {
    const bare = { ...spec, control: undefined, resume: undefined } as unknown as OpWavesSpec;
    expect(() => jobsOf(bare, { ...base, controlGroup: "c" })).toThrow(/the spec has no control/);
    expect(() => jobsOf(bare, { ...base, resumeGroup: "r" })).toThrow(/the spec has no resume/);
    expect(() => jobsOf(spec, { ...base, resumeGroup: "" })).toThrow(/one line/);
    expect(() => jobsOf(spec, { ...base, controlGroup: "a\nb" })).toThrow(/one line/);
  });
});
