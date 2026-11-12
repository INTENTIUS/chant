/**
 * #4982 on GitLab: a spec the job renders at run time. The wave job and its
 * `<wave job>-policy` job carry the product's command in
 * `CHANT_WAVES_SPEC_COMMAND` and pass `--render-spec`; the trade, the
 * evidence job and the needs are the ones the shape gives.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGitlabOpWavesPipeline } from "./generate-op-waves-pipeline";

const cloud = { aws: { role: "arn:aws:iam::123456789012:role/apply", region: "us-east-1", audience: "sts.amazonaws.com" } };
const shape: OpWavesSpec = {
  name: "tf-apply",
  op: "tf-apply",
  step: { kind: "terraform-apply", root: "{target}" },
  holds: { policy: true },
  waves: [{ name: "wave-1", runs: [{ target: "network" }], cloud }],
} as OpWavesSpec;
const base = { specFile: ".chant/op-waves/tf-apply.spec.json", bin: "terragucci", evidence: { identity: "oidc" as const } };

type Job = { needs?: string[]; variables?: Record<string, string>; script?: string[] };
const jobsOf = (o: Record<string, unknown>): Record<string, Job> => parseYAML(generateGitlabOpWavesPipeline(shape, { ...base, ...o }).files[0]!.yaml) as Record<string, Job>;

describe("a spec the job renders at run time on GitLab (#4982)", () => {
  test("the wave job and its policy job render the spec through the product's command", () => {
    const jobs = jobsOf({ renderSpec: { command: ["terragucci", "waves-spec"] } });
    const wave = jobs["wave-1-wave-1"]!;
    const policy = jobs["wave-1-wave-1-policy"]!;
    for (const job of [wave, policy]) expect(job.variables!.CHANT_WAVES_SPEC_COMMAND).toBe('["terragucci","waves-spec"]');
    expect(wave.script!.join("\n")).toContain("terragucci run wave --spec .chant/op-waves/tf-apply.spec.json --wave 1 --render-spec");
    expect(policy.script!.at(-1)).toBe("terragucci run wave --spec .chant/op-waves/tf-apply.spec.json --wave 1 --render-spec --policy-only");
    expect(wave.needs).toEqual(["wave-1-wave-1-policy"]);
    const ev = jobs["wave-1-wave-1-evidence"]!;
    expect(ev.variables!.CHANT_WAVES_SPEC_COMMAND).toBeUndefined();
  });

  test("runsAtHead: the wave job and its policy job carry CHANT_WAVES_SPEC_RUNS=head (#5046)", () => {
    const jobs = jobsOf({ renderSpec: { command: ["terragucci", "waves-spec"], runsAtHead: true } });
    for (const name of ["wave-1-wave-1", "wave-1-wave-1-policy"]) expect(jobs[name]!.variables!.CHANT_WAVES_SPEC_RUNS).toBe("head");
    expect(jobs["wave-1-wave-1-evidence"]!.variables!.CHANT_WAVES_SPEC_RUNS).toBeUndefined();
    expect(jobsOf({ renderSpec: { command: ["terragucci", "waves-spec"] } })["wave-1-wave-1"]!.variables!.CHANT_WAVES_SPEC_RUNS).toBeUndefined();
  });

  test("without renderSpec the jobs read the committed spec as before", () => {
    const jobs = jobsOf({});
    expect(jobs["wave-1-wave-1"]!.variables!.CHANT_WAVES_SPEC_COMMAND).toBeUndefined();
    expect(jobs["wave-1-wave-1"]!.script!.join("\n")).not.toContain("--render-spec");
  });
});
