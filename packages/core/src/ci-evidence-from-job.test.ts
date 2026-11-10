/**
 * #4926: `chant ci evidence sign --from-job` against a fake forge. It signs
 * only the checks whose steps passed, refuses a job of another commit or
 * run, gives a failed policy step no `policy:` evidence whatever its claim
 * file says, and each statement names the run, job and step it relied on.
 * The forge's job records come through the real reads with a fake `fetch`;
 * the signing is a real runner key over a local repository.
 */

import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ForgeFetch } from "./pr-forge";
import { githubReads, gitlabReads, type ForgeReads, type RunJob } from "./pr-forge-reads";
import { checksFromJob, signFromJob } from "./ci-evidence-from-job";
import { checkClaimFileName, parseEvidenceSources, readCheckClaimFile, writeCheckClaimFile } from "./ci-evidence-claims";
import { loadRunnerKey } from "./workspace/trust/dsse";
import { readCheckEvidence } from "./workspace/trust/check-evidence";

const SHA = "a".repeat(40);
const PLAN_STEP = "Plan, gate and apply wave 1 (dev)";
const POLICY_STEP = "Check wave 1 (dev)'s plans against the policy";
const SOURCES = { "plan:dev": { step: PLAN_STEP }, "policy:dev": { step: POLICY_STEP } };

/** A run's jobs as GitHub lists them, through the real reads. */
function githubRun(run: number, jobs: unknown[]): Pick<ForgeReads, "runJobs"> {
  const fetch: ForgeFetch = async (url) => {
    const u = new URL(url);
    if (u.pathname !== `/repos/acme/infra/actions/runs/${run}/jobs`) return { ok: false, status: 404, text: async () => "{}" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ total_count: jobs.length, jobs }) };
  };
  return githubReads({ apiBase: "https://api.github.com", repo: "acme/infra", token: "t", fetch });
}

const step = (name: string, conclusion: string, number: number) => ({ name, status: "completed", conclusion, number });
const waveJob = (over: Record<string, unknown> = {}, steps = [step(POLICY_STEP, "success", 4), step(PLAN_STEP, "success", 5)]) => ({ id: 77, run_id: 9, name: "wave-1-dev", status: "completed", conclusion: "success", head_sha: SHA, steps, ...over });

describe("the forge's record of a job (#4926)", () => {
  test("github and forgejo name the commit and the steps; gitlab names the pipeline's commit and no steps", async () => {
    const [job] = await githubRun(9, [waveJob()]).runJobs(9);
    expect(job).toMatchObject({ id: 77, run: 9, headSha: SHA, conclusion: "success" });
    expect(job!.steps).toEqual([{ name: POLICY_STEP, number: 4, status: "completed", conclusion: "success" }, { name: PLAN_STEP, number: 5, status: "completed", conclusion: "success" }]);
    const fetch: ForgeFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify([{ id: 5, name: "wave-1-dev-policy", status: "failed", pipeline: { id: 9, sha: SHA }, commit: { id: SHA } }]) });
    const [gl] = await gitlabReads({ apiBase: "https://gitlab.com/api/v4", project: "acme/infra", token: "t", fetch }).runJobs(9);
    expect(gl).toEqual({ id: 5, name: "wave-1-dev-policy", status: "failed", done: true, run: 9, headSha: SHA });
  });
});

describe("which checks a job's record lets the evidence job sign (#4926)", () => {
  const claims = (files: Array<{ check: string; passed: boolean; claim?: string }>): string => {
    const dir = mkdtempSync(join(tmpdir(), "chant-4926-claims-"));
    for (const f of files) writeCheckClaimFile(dir, f);
    return dir;
  };

  test("signs only the checks whose steps passed, each with the run, job and step it read", async () => {
    const reads = githubRun(9, [waveJob({}, [step(POLICY_STEP, "failure", 4), step(PLAN_STEP, "success", 5)])]);
    const got = await checksFromJob({ reads, run: 9, sha: SHA, fromJob: "wave-1-dev", checks: ["plan:dev", "policy:dev"], sources: SOURCES });
    expect(got).toEqual({
      sign: [{ check: "plan:dev", source: { run: 9, job: 77, step: PLAN_STEP } }],
      skipped: [{ check: "policy:dev", reason: `step ${JSON.stringify(POLICY_STEP)} of job wave-1-dev concluded failure` }],
    });
  });

  test("a failed policy step gets no policy evidence even when its claim file says it passed", async () => {
    const dir = claims([{ check: "plan:dev", passed: true, claim: "sha256:1" }, { check: "policy:dev", passed: true, claim: "[]" }]);
    const reads = githubRun(9, [waveJob({ conclusion: "failure" }, [step(POLICY_STEP, "failure", 4), step(PLAN_STEP, "success", 5)])]);
    const got = await checksFromJob({ reads, run: 9, sha: SHA, fromJob: "wave-1-dev", checks: ["plan:dev", "policy:dev"], sources: SOURCES, claims: dir });
    expect("sign" in got && got.sign.map((s) => [s.check, s.claim])).toEqual([["plan:dev", "sha256:1"]]);
  });

  test("a passed step whose claim file says the check did not pass, or left none, signs nothing", async () => {
    const dir = claims([{ check: "policy:dev", passed: false }]);
    const got = await checksFromJob({ reads: githubRun(9, [waveJob()]), run: 9, sha: SHA, fromJob: "wave-1-dev", checks: ["plan:dev", "policy:dev"], sources: SOURCES, claims: dir });
    expect(got).toEqual({
      sign: [],
      skipped: [
        { check: "plan:dev", reason: `the job left no readable ${checkClaimFileName("plan:dev")}` },
        { check: "policy:dev", reason: "job wave-1-dev's claim file says policy:dev did not pass" },
      ],
    });
  });

  test("a job of another commit or another run is refused", async () => {
    const other = "b".repeat(40);
    expect(await checksFromJob({ reads: githubRun(9, [waveJob({ head_sha: other })]), run: 9, sha: SHA, fromJob: "wave-1-dev", checks: ["plan:dev"], sources: SOURCES })).toEqual({
      refused: `job wave-1-dev (77) ran for commit ${other.slice(0, 12)}, not this run's ${SHA.slice(0, 12)}`,
    });
    expect(await checksFromJob({ reads: githubRun(9, [waveJob({ run_id: 8 })]), run: 9, sha: SHA, fromJob: "wave-1-dev", checks: ["plan:dev"], sources: SOURCES })).toEqual({ refused: "job wave-1-dev (77) belongs to run 8, not this run 9" });
    expect(await checksFromJob({ reads: githubRun(9, []), run: 9, sha: SHA, fromJob: "wave-1-dev", checks: ["plan:dev"] })).toEqual({ refused: "run 9 has no job named wave-1-dev" });
  });

  test("on gitlab a check is read from its job's status, the policy from the policy job", async () => {
    const jobs: RunJob[] = [
      { id: 40, name: "wave-1-dev", status: "success", done: true, run: 9, headSha: SHA },
      { id: 41, name: "wave-1-dev-policy", status: "failed", done: true, run: 9, headSha: SHA },
    ];
    const got = await checksFromJob({ reads: { runJobs: async () => jobs }, run: 9, sha: SHA, fromJob: "wave-1-dev", checks: ["plan:dev", "policy:dev"], sources: { "policy:dev": { job: "wave-1-dev-policy" } } });
    expect(got).toEqual({ sign: [{ check: "plan:dev", source: { run: 9, job: 40 } }], skipped: [{ check: "policy:dev", reason: "job wave-1-dev-policy ended failed" }] });
  });

  test("the sources and claim files read as data", () => {
    expect(parseEvidenceSources('{"plan:dev":"Plan","policy:dev":{"job":"p"}}')).toEqual({ sources: { "plan:dev": { step: "Plan" }, "policy:dev": { job: "p" } } });
    expect(parseEvidenceSources("[]")).toHaveProperty("problem");
    const dir = mkdtempSync(join(tmpdir(), "chant-4926-claim-"));
    writeFileSync(join(dir, checkClaimFileName("policy:dev")), JSON.stringify({ check: "policy:prod", passed: true }));
    expect(readCheckClaimFile(dir, "policy:dev")).toEqual({ problem: "policy-dev.json is not policy:dev's claim file" });
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

describe("signFromJob (#4926)", () => {
  test("signs the passed checks over the run's commit, with the source in the statement, and refuses another commit", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "chant-4926-sign-"));
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    git(cwd, "init", "--quiet");
    mkdirSync(join(cwd, ".chant"));
    writeFileSync(join(cwd, ".chant/trust.json"), JSON.stringify({ schema: 1, runners: [{ principal: "ci", class: "runner", key: loadRunnerKey(pem).publicKey }] }));
    git(cwd, "add", ".");
    git(cwd, "commit", "--quiet", "-m", "base");
    const base = git(cwd, "rev-parse", "HEAD");
    writeFileSync(join(cwd, "main.tf"), "# change\n");
    git(cwd, "add", "main.tf");
    git(cwd, "commit", "--quiet", "-m", "merge");
    const head = git(cwd, "rev-parse", "HEAD");
    const reads = githubRun(9, [waveJob({ head_sha: head }, [step(POLICY_STEP, "failure", 4), step(PLAN_STEP, "success", 5)])]);
    const env = { GITHUB_RUN_ID: "9", GITHUB_SHA: head, CHANT_EVIDENCE_SOURCES: JSON.stringify(SOURCES) } as NodeJS.ProcessEnv;
    const logs: string[] = [];
    const done = await signFromJob({ repo: cwd, base, fromJob: "wave-1-dev", checks: ["plan:dev", "policy:dev"], reads, env, key: pem, push: false, log: (l) => logs.push(l) });
    expect(done).toMatchObject({ signed: [{ check: "plan:dev", runner: "ci", commit: head, source: { run: 9, job: 77, step: PLAN_STEP } }] });
    expect((await readCheckEvidence(cwd, head, base, ["plan:dev", "policy:dev"])).map((v) => v.status)).toEqual(["current", "missing"]);
    const note = git(cwd, "notes", "--ref", "refs/notes/chant/evidence", "show", head);
    const statement = JSON.parse(Buffer.from(JSON.parse(note.split("\n")[0]!).payload, "base64").toString("utf8"));
    expect(statement.predicate.source).toEqual({ run: 9, job: 77, step: PLAN_STEP });
    expect(logs.some((l) => l.startsWith("ci evidence: policy:dev not signed: step"))).toBe(true);
    expect(await signFromJob({ repo: cwd, base, fromJob: "wave-1-dev", checks: ["plan:dev"], at: base, reads, env, key: pem, push: false, log: () => {} })).toEqual({
      refused: `--at names ${base.slice(0, 12)}, and this run is for ${head.slice(0, 12)}; --from-job signs only the run's own commit`,
    });
  });
});
