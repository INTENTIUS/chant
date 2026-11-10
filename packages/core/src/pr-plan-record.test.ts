/**
 * #4899: the product plan job's run record, written by the plan step's
 * record line and read back as data by the note job; and #4935's pull
 * request loop flags.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PLAN_RECORD_JS, PLAN_RUN_RECORD_ENV, planVerbLines } from "./components/product-plan";
import { PLAN_RUN_RECORD_FILE, readPlanRunRecord } from "./pr-plan-record";
import { prLoopFlagsProblem } from "./cli/handlers/build";
import { prCheckJob, PR_CHECK_REPORT_DIR, prRefGateJob } from "./components/pr-checks";
import { CHECK_HOOKS_DIR } from "./components/check-hooks";

const HEAD = "a".repeat(40);
const config = JSON.stringify({ op: "pr-plan", env: "prod", labels: { Env: "prod", Pipeline: "pr", Job: "plan", Target: "staging" } });

function written(exit: number): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-plan-record-"));
  execFileSync(process.execPath, ["-e", PLAN_RECORD_JS, dir], { cwd: dir, env: { ...process.env, [PLAN_RUN_RECORD_ENV]: config, CHANT_PLAN_EXIT: String(exit), CHANT_PLAN_STARTED: "2026-11-10T00:00:00Z" } });
  return dir;
}

describe("the product plan job's run record (#4899)", () => {
  test("the record line writes a record the note job keeps, its op, commit and origin its own", () => {
    const dir = written(0);
    const raw = JSON.parse(readFileSync(join(dir, PLAN_RUN_RECORD_FILE), "utf-8"));
    expect(raw).toMatchObject({ op: "pr-plan", env: "prod", status: "ok", started: "2026-11-10T00:00:00.000Z" });
    const read = readPlanRunRecord(dir, { env: "prod", head: HEAD, target: "staging", result: "success", origin: { forge: "github", jobId: "plan-staging" } });
    expect(read && "record" in read ? read.record : read).toMatchObject({ id: raw.id, op: "pr-plan", status: "ok", gitSha: HEAD, runOrigin: { forge: "github", jobId: "plan-staging" }, labels: { Target: "staging" } });
  });

  test("a failed verb, or a failed job, records a failed run", () => {
    const failed = readPlanRunRecord(written(3), { env: "prod", head: HEAD, target: "staging" });
    expect(failed && "record" in failed ? failed.record.failure : failed).toEqual({ code: "command-failed", reason: "the plan verb exited 3", phase: "plan", exitCode: 3 });
    const job = readPlanRunRecord(written(0), { env: "prod", head: HEAD, target: "staging", result: "failure" });
    expect(job && "record" in job ? job.record.status : job).toBe("fail");
  });

  test("a record for another environment, target or commit is refused, and none is undefined", () => {
    const dir = written(0);
    expect(readPlanRunRecord(dir, { env: "dev", head: HEAD, target: "staging" })).toEqual({ refused: expect.stringMatching(/environment "prod", not dev/) });
    expect(readPlanRunRecord(dir, { env: "prod", head: HEAD })).toEqual({ refused: expect.stringMatching(/target "staging"/) });
    const forged = JSON.parse(readFileSync(join(dir, PLAN_RUN_RECORD_FILE), "utf-8"));
    writeFileSync(join(dir, PLAN_RUN_RECORD_FILE), JSON.stringify({ ...forged, gitSha: "b".repeat(40) }));
    expect(readPlanRunRecord(dir, { env: "prod", head: HEAD, target: "staging" })).toEqual({ refused: expect.stringMatching(/commit/) });
    expect(readPlanRunRecord(mkdtempSync(join(tmpdir(), "chant-plan-record-")), { env: "prod", head: HEAD })).toBeUndefined();
  });

  test("the plan step's lines: the verb alone without record or report", () => {
    expect(planVerbLines({ command: "yodel plan" })).toEqual(["yodel plan"]);
    const lines = planVerbLines({ command: "yodel plan", record: { env: {} } });
    expect(lines[0]).toMatch(/^chant_plan_started=/);
    expect(lines.at(-1)).toBe('[ "$chant_plan_exit" -eq 0 ] || exit "$chant_plan_exit"');
  });
});

describe("the pull request loop's evidence, check and ref gate flags (#4935)", () => {
  test("they need --pr-loop and one runner identity", () => {
    expect(prLoopFlagsProblem({ checkJob: true })).toMatch(/--check-job .*needs --pr-loop/);
    expect(prLoopFlagsProblem({ prLoop: true, evidenceRunnerKeySecret: "K", evidenceIdentity: "oidc" })).toMatch(/give one of them/);
    expect(prLoopFlagsProblem({ prLoop: true, evidenceAudience: "x" })).toMatch(/goes with --evidence-identity oidc/);
    expect(prLoopFlagsProblem({ prLoop: true, evidenceRunnerKeySecret: "1K" })).toMatch(/secret name/);
    expect(prLoopFlagsProblem({ prLoop: true, evidenceIdentity: "oidc", evidenceAudience: "sigstore", checkJob: true, refGateStatus: true })).toBeUndefined();
  });

  test("the descriptors: the check report directory is ci check's, and the gate's branch is checked", () => {
    expect(PR_CHECK_REPORT_DIR).toBe(CHECK_HOOKS_DIR);
    expect(prCheckJob("github").evidence).toBeUndefined();
    expect(() => prCheckJob("github", { evidence: { runnerKeySecret: "not a name" } })).toThrow(/secret name/);
    expect(() => prRefGateJob("github", { branch: "a b" })).toThrow(/not a branch name/);
  });
});
