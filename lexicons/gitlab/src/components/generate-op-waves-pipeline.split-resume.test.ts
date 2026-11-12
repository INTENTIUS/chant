/**
 * #5052: under `approvals.remainder` a GitLab split wave's gate job is told
 * the names of the wave's applying and record jobs, so its applied line
 * names them and `chant run resume` retries a killed apply. Without
 * `remainder` the jobs render as before (the `op-waves-defaults-*` goldens).
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { parseYAML } from "@intentius/chant/yaml";
import { OP_WAVES_RESUME_ENV } from "@intentius/chant/op/op-waves-split-resume";
import { generateGitlabOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec = (approvals?: Record<string, boolean>) =>
  ({
    name: "tf-apply",
    op: "tf-apply",
    planWave: ["terragucci", "plan-wave", "{runs}", "{plans}"],
    apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
    ...(approvals ? { approvals } : {}),
    waves: [{ name: "canary", runs: [], discover: true }, { name: "wide", runs: [], discover: true, shares: 2 }],
  }) as unknown as OpWavesSpec;

type Job = { variables?: Record<string, string>; script?: string[] };
const jobsOf = (s: OpWavesSpec, jobNames?: (j: { role: string; wave?: number; share?: number }) => string | undefined) =>
  parseYAML(generateGitlabOpWavesPipeline(s, { specFile: "w.json", beforeMerge: { merge: "manual" }, ...(jobNames ? { jobNames: jobNames as never } : {}) }).files[0]!.yaml) as Record<string, Job>;

describe("the GitLab gate job's resume target (#5052)", () => {
  test("each gate job names its wave's applying jobs and record job; no other job carries it", () => {
    const jobs = jobsOf(spec({ spend: true, remainder: true }));
    expect(JSON.parse(jobs["wave-1-canary-gate"]!.variables![OP_WAVES_RESUME_ENV]!)).toEqual({ apply: ["wave-1-canary"], record: "wave-1-canary-record" });
    expect(JSON.parse(jobs["wave-2-wide-gate"]!.variables![OP_WAVES_RESUME_ENV]!)).toEqual({ apply: ["wave-2-wide-share-1", "wave-2-wide-share-2"], record: "wave-2-wide-record" });
    for (const [name, job] of Object.entries(jobs)) if (!name.endsWith("-gate") && job?.variables) expect(job.variables[OP_WAVES_RESUME_ENV], name).toBeUndefined();
  });

  test("under the product's job names", () => {
    const names = (j: { role: string; wave?: number }) => (j.role === "apply" ? `apply-wave-${j.wave}` : j.role === "record" ? `apply-wave-${j.wave}-record` : undefined);
    const jobs = jobsOf({ ...spec({ spend: true, remainder: true }), waves: [{ name: "canary", runs: [], discover: true }] } as OpWavesSpec, names);
    expect(JSON.parse(jobs["wave-1-canary-gate"]!.variables![OP_WAVES_RESUME_ENV]!)).toEqual({ apply: ["apply-wave-1"], record: "apply-wave-1-record" });
  });

  test("without approvals.remainder nothing changes", () => {
    for (const job of Object.values(jobsOf(spec({ spend: true })))) if (job?.variables) expect(job.variables[OP_WAVES_RESUME_ENV]).toBeUndefined();
  });
});
