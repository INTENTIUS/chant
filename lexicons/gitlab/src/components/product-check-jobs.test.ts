/** #4964 on GitLab: the check jobs for a product's own pipeline, with the product's service containers on the check job. */
import { describe, expect, test } from "vitest";
import { gitlabProductCheckJobs } from "./product-check-jobs";

const yodel = { product: "yodel", noun: ["environment", "environments"] as [string, string], commands: {}, approve: "yodel approve {target} --plan {digest} {sign}", op: "yodel-apply", gateName: "yodel-apply-wave-{k}", approval: "per-wave" as const, bin: "yodel chant" };
const replay = { name: "replay-postgres", image: "postgres:18.6", env: { POSTGRES_PASSWORD: "replay" } };
const checkJob = { services: [replay], env: { REPLAY_POSTGRES_URL: "postgres://replay-postgres:5432/postgres" }, before: ["node wait-for.js replay-postgres 5432"] };
type Job = { services?: unknown; rules: Array<{ if: string }>; script: string[]; variables?: Record<string, string>; environment?: unknown };

describe("the check jobs in a product's own GitLab pipeline (#4964)", () => {
  test("the check job with its service in the merge request pipeline, the signing and ref gate jobs in the plan notes pipeline", () => {
    const out = gitlabProductCheckJobs("default", { words: yodel, checkJob, refGateStatus: true, evidence: { runnerKeySecret: "K" } });
    const jobs = Object.fromEntries(out.entries) as Record<string, Job>;
    expect(Object.keys(jobs)).toEqual(["check", "check-evidence", "ref-gate"]);
    expect(jobs.check!.services).toEqual([{ name: "postgres:18.6", alias: "replay-postgres", variables: { POSTGRES_PASSWORD: "replay" } }]);
    expect(jobs.check!.variables).toEqual({ BASE_SHA: "$CI_MERGE_REQUEST_DIFF_BASE_SHA", REPLAY_POSTGRES_URL: "postgres://replay-postgres:5432/postgres" });
    expect(jobs.check!.script.slice(-2)).toEqual(["node wait-for.js replay-postgres 5432", 'yodel chant ci check --base "$BASE_SHA"']);
    expect(jobs.check!.script).toContain("unset K");
    expect(jobs.check!.rules[0]!.if).toBe(out.rules.mergeRequest);
    expect(jobs["check-evidence"]!.rules[0]!.if).toBe(out.rules.planNotes);
    expect(jobs["check-evidence"]!.environment).toEqual({ name: "chant-evidence", action: "access" });
    expect(jobs["ref-gate"]!.rules[0]!.if).toBe(out.rules.planNotes);
    expect(out.stages).toEqual(["plan", "evidence", "ref-gate"]);
  });
});
