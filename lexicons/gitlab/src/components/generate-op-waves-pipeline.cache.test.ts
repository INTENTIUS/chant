/**
 * #5045: the GitLab wave jobs that run the wave's command take a product's
 * `cache:`, such as terragucci's Terragrunt sources and providers cache.
 * The gate and record jobs plan and apply nothing, so they take none.
 * Without it the jobs render as before (the `op-waves-defaults-*` goldens).
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
  holds: { policy: true },
  waves: [
    { name: "canary", runs: [], discover: true },
    { name: "wide", runs: [], discover: true, shares: 2 },
  ],
} as unknown as OpWavesSpec;

const CACHE = [{ key: "terragucci-terragrunt", paths: [".terragrunt-cache/"] }];
const base: OpWavesPipelineOptions = { specFile: "w.json", bin: "terragucci", evidence: { identity: "oidc" } };
type Job = { cache?: unknown; script?: string[] };
const jobsOf = (o: OpWavesPipelineOptions) => {
  const doc = parseYAML(generateGitlabOpWavesPipeline(spec, o).files[0]!.yaml) as Record<string, Job>;
  return Object.fromEntries(Object.entries(doc).filter(([, v]) => v && typeof v === "object" && !Array.isArray(v) && "script" in v)) as Record<string, Job>;
};

describe("the GitLab wave jobs' cache (#5045)", () => {
  test("a push: every job that runs the wave's command keeps the cache, the others none", () => {
    const jobs = jobsOf({ ...base, cache: CACHE });
    const cached = ["wave-1-canary", "wave-1-canary-policy", "wave-2-wide-decide", "wave-2-wide-decide-policy", "wave-2-wide-share-1", "wave-2-wide-share-2"];
    for (const name of cached) expect(jobs[name]?.cache, name).toEqual(CACHE);
    for (const [name, job] of Object.entries(jobs)) if (!cached.includes(name)) expect(job.cache, name).toBeUndefined();
  });

  test("before merge: the plan, policy and applying jobs keep it; the gate and record jobs do not", () => {
    const jobs = jobsOf({ ...base, cache: { key: "k", paths: [".terragrunt-cache/"] }, beforeMerge: { merge: "manual" } });
    for (const name of ["wave-1-canary-plan", "wave-1-canary-plan-policy", "wave-1-canary", "wave-2-wide-plan", "wave-2-wide-share-1"]) expect(jobs[name]?.cache, name).toEqual({ key: "k", paths: [".terragrunt-cache/"] });
    for (const name of ["wave-1-canary-gate", "wave-1-canary-record", "wave-2-wide-gate", "wave-2-wide-record"]) expect(jobs[name]!.cache, name).toBeUndefined();
  });

  test("without it nothing changes", () => {
    for (const job of Object.values(jobsOf(base))) expect(job.cache).toBeUndefined();
  });

  test("refused: an empty list, an entry that is not a mapping, one with neither paths nor key", () => {
    expect(() => jobsOf({ ...base, cache: [] })).toThrow(/leave it out for none/);
    expect(() => jobsOf({ ...base, cache: ["x"] as never })).toThrow(/each a mapping/);
    expect(() => jobsOf({ ...base, cache: { when: "always" } })).toThrow(/names its paths or its key/);
  });
});
