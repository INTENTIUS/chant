/**
 * #5032: Op waves that run from the repository's default branch on Forgejo,
 * by the name the push event gives it. Forgejo's push payload carries
 * `repository.default_branch`, as GitHub's does, and its runner exposes the
 * payload as `github.event`. The default branch here is `trunk`.
 */
import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import type { OpWavesPipelineOptions } from "@intentius/chant/lexicon";
import { JOB_DEFAULT_BRANCH_ENV, JOB_GUARD_ENV } from "@intentius/chant/ci-job-guard";
import { CHANT_EXIT } from "@intentius/chant/exit-codes";
import { buildForgejoOpWavesDoc } from "./generate-op-waves-pipeline";

const spec = {
  name: "tf-apply",
  op: "tf-apply",
  planWave: ["terragucci", "plan-wave", "{runs}", "{plans}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  defaultBranch: true,
  branches: ["release"],
  waves: [
    { name: "canary", runs: [], discover: true },
    { name: "rest", runs: [], discover: true, rest: true },
  ],
} as unknown as OpWavesSpec;

const options: OpWavesPipelineOptions = { specFile: ".chant/op-waves/tf-apply.spec.json", bin: "terragucci", applyStatus: { context: "terragucci/apply" }, beforeMerge: { merge: "auto", mergeTokenSecret: "TG_MERGE_TOKEN" } };

type Step = { env?: Record<string, string>; run?: string };
type Job = { if?: string; env?: Record<string, string>; steps: Step[] };

describe("Op waves from the default branch on Forgejo (#5032)", () => {
  test("every guard admits the default branch and the named one, from the job's CHANT_DEFAULT_BRANCH", () => {
    const { doc } = buildForgejoOpWavesDoc(spec, options);
    const jobs = doc.jobsDoc as Record<string, Job>;
    const guarded = Object.entries(jobs).filter(([, job]) => job.steps.some((s) => s.env?.[JOB_GUARD_ENV]));
    expect(guarded.length).toBeGreaterThan(4);
    for (const [name, job] of guarded) {
      const step = job.steps.find((s) => s.env?.[JOB_GUARD_ENV])!;
      expect(JSON.parse(step.env![JOB_GUARD_ENV]!), name).toMatchObject({ forge: "forgejo", branches: ["release"], defaultBranch: true });
      expect(job.env?.[JOB_DEFAULT_BRANCH_ENV], name).toBe("${{ github.event.repository.default_branch }}");
      const run = (ref: string) => spawnSync("sh", ["-c", step.run!], { env: { PATH: process.env.PATH ?? "", GITHUB_REF: ref, [JOB_DEFAULT_BRANCH_ENV]: "trunk", [JOB_GUARD_ENV]: step.env![JOB_GUARD_ENV]! }, encoding: "utf-8" });
      expect(run("refs/heads/trunk").status, name).toBe(0);
      expect(run("refs/heads/release").status, name).toBe(0);
      expect(run("refs/heads/main").status, name).toBe(CHANT_EXIT.misplaced);
    }
    for (const [name, job] of Object.entries(jobs)) {
      expect(job.if, name).toContain("(github.event_name == 'push' && (github.ref == format('refs/heads/{0}', github.event.repository.default_branch) || github.ref == 'refs/heads/release'))");
    }
    expect((doc.on as { push: unknown }).push).toEqual({ branches: ["**"] });
  });
});
