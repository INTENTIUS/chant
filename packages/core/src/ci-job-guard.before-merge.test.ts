/**
 * The guard before merge (#4984): a waves run started for an open pull
 * request's head is admitted only as the decision recorded for that head on
 * `chant/lifecycle`, and every other run that names a head is refused. The
 * `node -e` program reads the decision from a real repository and agrees
 * with checkJob.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { checkJob, describeJobGuard, JOB_GUARD_ENV, JOB_GUARD_JS, jobGuardSpec, jobSeen, type JobGuardSpec } from "./ci-job-guard";
import { CHANT_EXIT } from "./exit-codes";
import { beforeMergeDigest, beforeMergePath, renderBeforeMerge, type BeforeMergeRecord } from "./op/before-merge";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const BASE = "c".repeat(40);
const decision = { pr: 7, head: HEAD, base: BASE, at: "2026-11-10T12:00:00.000Z", by: "alice" };
const record: BeforeMergeRecord = { ...decision, digest: beforeMergeDigest("deploy", decision) };

const gh: JobGuardSpec = { forge: "github", job: "wave 1 (prod) of deploy", branches: ["main"], beforeMerge: { op: "deploy" } };
const gl: JobGuardSpec = { forge: "gitlab", job: "wave 1 (prod) of deploy", branches: ["main"], beforeMerge: { op: "deploy" } };
const run = { pr: "7", head: HEAD, digest: record.digest };

describe("checkJob before merge", () => {
  test("the decided head, on the default branch, runs", () => {
    const r = checkJob(gh, { ref: "refs/heads/main", beforeMerge: run, beforeMergeRecord: record });
    expect(r.problems).toEqual([]);
    expect(r.checked).toEqual(["ref refs/heads/main", `before merge: pull request 7's decided head ${HEAD.slice(0, 12)}`]);
  });

  test("a push run names no head and is checked as before", () => {
    expect(checkJob(gh, { ref: "refs/heads/main" }).checked).toEqual(["ref refs/heads/main"]);
  });

  test("a head no decision names is refused", () => {
    const r = checkJob(gh, { ref: "refs/heads/main", beforeMerge: { ...run, head: OTHER }, beforeMergeRecord: null });
    expect(r.problems).toEqual([`before merge: no decision on chant/lifecycle names head ${OTHER.slice(0, 12)} of deploy, so this run applies nothing`]);
  });

  test("another pull request's run, another digest, and a decision edited by hand are refused", () => {
    expect(checkJob(gh, { ref: "refs/heads/main", beforeMerge: { ...run, pr: "8" }, beforeMergeRecord: record }).problems).toEqual([`before merge: the decision for head ${HEAD.slice(0, 12)} is pull request 7's, not 8's`]);
    const other = `sha256:${"0".repeat(64)}`;
    expect(checkJob(gh, { ref: "refs/heads/main", beforeMerge: { ...run, digest: other }, beforeMergeRecord: record }).problems).toEqual([`before merge: the run carries digest ${other}, and the decision for head ${HEAD.slice(0, 12)} has ${record.digest}`]);
    expect(checkJob(gh, { ref: "refs/heads/main", beforeMerge: run, beforeMergeRecord: { ...record, through: 1 } }).problems).toEqual([`before merge: the decision for head ${HEAD.slice(0, 12)} was changed after it was made: its fields give another digest`]);
  });

  test("a decided head started on another ref is refused for the ref", () => {
    const r = checkJob(gh, { ref: "refs/heads/feature", beforeMerge: run, beforeMergeRecord: record });
    expect(r.problems).toEqual(["ref: expected refs/heads/main, found refs/heads/feature"]);
    const l = checkJob(gl, { ref: "feature", refProtected: "false", forgeEnvironment: null, beforeMerge: run, beforeMergeRecord: record });
    expect(l.problems).toEqual(["ref: expected main, found feature", "ref: expected a protected ref (CI_COMMIT_REF_PROTECTED true), found false"]);
  });

  test("a job without the before-merge mode refuses any run that names a head", () => {
    const spec: JobGuardSpec = { forge: "github", job: "w", branches: ["main"] };
    expect(checkJob(spec, { ref: "refs/heads/main", beforeMerge: run }).problems).toEqual([`before merge: the run names pull request 7's head ${HEAD}, and this job applies only the pushes to its branches`]);
  });

  test("variables that are not a decision's, and a ledger that cannot be read", () => {
    expect(checkJob(gh, { ref: "refs/heads/main", beforeMerge: { head: "main" } }).problems).toEqual([
      "before merge: the run's pull request none is not a number",
      'before merge: the run\'s head "main" is not a commit sha',
      "before merge: the run's digest none is not a sha256 digest",
    ]);
    expect(checkJob(gh, { ref: "refs/heads/main", beforeMerge: run, beforeMergeError: "no token" }).problems).toEqual(["before merge: the decisions on chant/lifecycle could not be read: no token"]);
  });

  test("jobGuardSpec carries the mode", () => {
    expect(jobGuardSpec({ forge: "forgejo", job: "w", branches: ["main"], beforeMerge: { op: "deploy" } }).beforeMerge).toEqual({ op: "deploy" });
  });

  test("jobSeen reads the decision for the run's head only with the mode", async () => {
    const env = { GITHUB_REF: "refs/heads/main", CHANT_BEFORE_MERGE_PR: "7", CHANT_BEFORE_MERGE_HEAD: HEAD, CHANT_BEFORE_MERGE_DIGEST: record.digest };
    const read: string[] = [];
    const reader = (_f: string, _e: NodeJS.ProcessEnv, path: string) => {
      read.push(path);
      return renderBeforeMerge({ version: 1, heads: { [HEAD]: record } });
    };
    const seen = await jobSeen(gh, env, fetch, reader);
    expect(read).toEqual([beforeMergePath("deploy")]);
    expect(seen.beforeMergeRecord).toEqual(record);
    const plain = await jobSeen({ forge: "github", job: "w", branches: ["main"] }, env, fetch, reader);
    expect(plain.beforeMergeRecord).toBeUndefined();
    expect(read).toHaveLength(1);
  });
});

describe("the node -e program reads the decision from chant/lifecycle", () => {
  let server = "";
  beforeAll(() => {
    // A bare repository standing in for the forge, with the decisions file on chant/lifecycle.
    server = mkdtempSync(join(tmpdir(), "chant-guard-forge-"));
    const work = mkdtempSync(join(tmpdir(), "chant-guard-work-"));
    const git = (cwd: string, ...args: string[]) => {
      const r = spawnSync("git", args, { cwd, encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
      if (r.status !== 0) throw new Error(r.stderr);
    };
    mkdirSync(join(server, "acme"), { recursive: true });
    git(join(server, "acme"), "init", "-q", "--bare", "infra.git");
    git(work, "init", "-q", "-b", "chant/lifecycle");
    mkdirSync(join(work, "_waves"));
    writeFileSync(join(work, beforeMergePath("deploy")), renderBeforeMerge({ version: 1, heads: { [HEAD]: record } }));
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "decide");
    git(work, "push", "-q", join(server, "acme", "infra.git"), "chant/lifecycle");
  });

  const run = (spec: JobGuardSpec, env: Record<string, string>) =>
    spawnSync(process.execPath, ["-e", JOB_GUARD_JS], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", [JOB_GUARD_ENV]: JSON.stringify(spec), ...env }, encoding: "utf-8" });
  const forgeEnv = (spec: JobGuardSpec): Record<string, string> =>
    spec.forge === "gitlab"
      ? { CI_SERVER_URL: `file://${server}`, CI_PROJECT_PATH: "acme/infra", CI_JOB_TOKEN: "t", CI_COMMIT_REF_NAME: "main", CI_COMMIT_REF_PROTECTED: "true" }
      : { GITHUB_SERVER_URL: `file://${server}`, GITHUB_REPOSITORY: "acme/infra", GITHUB_TOKEN: "t", GITHUB_REF: "refs/heads/main" };

  const cases: Array<[string, JobGuardSpec, Record<string, string>]> = [
    ["GitHub: the decided head", gh, { CHANT_BEFORE_MERGE_PR: "7", CHANT_BEFORE_MERGE_HEAD: HEAD, CHANT_BEFORE_MERGE_DIGEST: record.digest }],
    ["GitLab: the decided head", gl, { CHANT_BEFORE_MERGE_PR: "7", CHANT_BEFORE_MERGE_HEAD: HEAD, CHANT_BEFORE_MERGE_DIGEST: record.digest }],
    ["Forgejo: a head nothing decided", { ...gh, forge: "forgejo" }, { CHANT_BEFORE_MERGE_PR: "7", CHANT_BEFORE_MERGE_HEAD: OTHER, CHANT_BEFORE_MERGE_DIGEST: record.digest }],
    ["GitHub: another pull request's number", gh, { CHANT_BEFORE_MERGE_PR: "9", CHANT_BEFORE_MERGE_HEAD: HEAD, CHANT_BEFORE_MERGE_DIGEST: record.digest }],
    ["GitHub: the decided head dispatched on another branch", gh, { GITHUB_REF: "refs/heads/feature", CHANT_BEFORE_MERGE_PR: "7", CHANT_BEFORE_MERGE_HEAD: HEAD, CHANT_BEFORE_MERGE_DIGEST: record.digest }],
    ["GitLab: a head that is not a sha", gl, { CHANT_BEFORE_MERGE_HEAD: "refs/heads/feature" }],
    ["GitHub: no mode, and a run that names a head", { forge: "github", job: "w", branches: ["main"] }, { CHANT_BEFORE_MERGE_HEAD: HEAD }],
  ];

  for (const [name, spec, extra] of cases) {
    test(name, async () => {
      const env = { ...forgeEnv(spec), ...extra };
      const r = run(spec, env);
      const want = describeJobGuard(spec, checkJob(spec, await jobSeen(spec, { ...process.env, ...env }, (() => Promise.reject(new Error("no fetch"))) as unknown as typeof fetch)));
      expect(r.status).toBe(want.ok ? 0 : CHANT_EXIT.misplaced);
      expect(r.stdout.trim().split("\n").filter(Boolean)).toEqual(want.out);
      expect(r.stderr.trim().split("\n").filter(Boolean)).toEqual(want.err);
    });
  }

  test("the decided head is admitted, and any other ref refused", async () => {
    expect(run(gh, { ...forgeEnv(gh), CHANT_BEFORE_MERGE_PR: "7", CHANT_BEFORE_MERGE_HEAD: HEAD, CHANT_BEFORE_MERGE_DIGEST: record.digest }).status).toBe(0);
    for (const head of [OTHER, BASE]) {
      const r = run(gh, { ...forgeEnv(gh), CHANT_BEFORE_MERGE_PR: "7", CHANT_BEFORE_MERGE_HEAD: head, CHANT_BEFORE_MERGE_DIGEST: record.digest });
      expect(r.status).toBe(CHANT_EXIT.misplaced);
      expect(r.stderr).toContain(`no decision on chant/lifecycle names head ${head.slice(0, 12)}`);
    }
  });
});
