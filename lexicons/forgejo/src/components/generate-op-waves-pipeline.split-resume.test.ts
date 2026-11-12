/**
 * #5052: under `approvals.remainder` a Forgejo split wave's gate job is told
 * the product's dispatch input names, so its applied line names the run's
 * inputs and `chant run resume` dispatches the same decided head again.
 * GitHub's gate job needs nothing: a re-run of its run runs the applying
 * and record jobs again.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { OP_WAVES_RESUME_ENV } from "@intentius/chant/op/op-waves-split-resume";
import { buildGithubOpWavesDoc } from "@intentius/chant-lexicon-github/components/generate-op-waves-pipeline";
import { buildForgejoOpWavesDoc } from "./generate-op-waves-pipeline";

const spec = (approvals?: Record<string, boolean>) =>
  ({
    name: "tf-apply",
    op: "tf-apply",
    planWave: ["terragucci", "plan-wave", "{runs}", "{plans}"],
    apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
    ...(approvals ? { approvals } : {}),
    waves: [{ name: "canary", runs: [], discover: true }],
  }) as unknown as OpWavesSpec;

type Job = { env?: Record<string, string> };
const options = (o: Record<string, unknown> = {}) => ({ specFile: "w.json", beforeMerge: { merge: "manual" as const }, ...o });

describe("the Forgejo gate job's resume target (#5052)", () => {
  test("the gate job carries the product's input names; no other job does", () => {
    const jobs = buildForgejoOpWavesDoc(spec({ spend: true, remainder: true }), options({ dispatchInputs: { pr: "apply_pr", head: "apply_head", digest: "apply_digest" } })).doc.jobsDoc as Record<string, Job>;
    expect(JSON.parse(jobs["wave-1-canary-gate"]!.env![OP_WAVES_RESUME_ENV]!)).toEqual({ inputs: { pr: "apply_pr", head: "apply_head", digest: "apply_digest", wave: "wave", commit: "commit" } });
    for (const [name, job] of Object.entries(jobs)) if (name !== "wave-1-canary-gate") expect(job.env?.[OP_WAVES_RESUME_ENV], name).toBeUndefined();
    const plain = buildForgejoOpWavesDoc(spec({ spend: true, remainder: true }), options()).doc.jobsDoc as Record<string, Job>;
    expect(plain["wave-1-canary-gate"]!.env![OP_WAVES_RESUME_ENV]).toBe("{}");
  });

  test("GitHub's gate job and a spec without approvals.remainder carry nothing", () => {
    const github = buildGithubOpWavesDoc(spec({ spend: true, remainder: true }), options()).doc.jobsDoc as Record<string, Job>;
    const without = buildForgejoOpWavesDoc(spec({ spend: true }), options()).doc.jobsDoc as Record<string, Job>;
    for (const job of [...Object.values(github), ...Object.values(without)]) expect(job.env?.[OP_WAVES_RESUME_ENV]).toBeUndefined();
  });
});
