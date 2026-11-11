/**
 * #4992: the guard admits a follow-on run of the rest wave only in a job of
 * the rest wave, only for a wave after it, and only as the same decided
 * head: a follow-on for another head or digest is refused as any run of
 * one is. A push's follow-on names its commit. The `node -e` program agrees
 * with checkJob, reading the decision from a real repository.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { checkJob, describeJobGuard, JOB_GUARD_ENV, JOB_GUARD_JS, jobGuardSpec, jobSeen, parseJobGuardSpec, type JobGuardSpec } from "./ci-job-guard";
import { CHANT_EXIT } from "./exit-codes";
import { beforeMergeDigest, beforeMergePath, renderBeforeMerge, type BeforeMergeRecord } from "./op/before-merge";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const BASE = "c".repeat(40);
const PUSHED = "d".repeat(40);
const decision = { pr: 7, head: HEAD, base: BASE, at: "2026-11-10T12:00:00.000Z", by: "alice" };
const record: BeforeMergeRecord = { ...decision, digest: beforeMergeDigest("deploy", decision) };
const run = { pr: "7", head: HEAD, digest: record.digest };

const rest: JobGuardSpec = { forge: "github", job: "the plan job of wave 3 (rest) of deploy", branches: ["main"], beforeMerge: { op: "deploy" }, rest: 3 };
const earlier: JobGuardSpec = { forge: "github", job: "the plan job of wave 2 (layer) of deploy", branches: ["main"], beforeMerge: { op: "deploy" } };
const at = { ref: "refs/heads/main" };

describe("checkJob in a follow-on run (#4992)", () => {
  test("the rest wave's jobs admit a follow-on of the decided head for a later wave", () => {
    const r = checkJob(rest, { ...at, beforeMerge: run, beforeMergeRecord: record, followOn: { wave: "4" } });
    expect(r.problems).toEqual([]);
    expect(r.checked).toEqual(["ref refs/heads/main", `before merge: pull request 7's decided head ${HEAD.slice(0, 12)}`, "follow-on wave 4"]);
  });

  test("a follow-on for another head or another digest is refused", () => {
    expect(checkJob(rest, { ...at, beforeMerge: { ...run, head: OTHER }, beforeMergeRecord: null, followOn: { wave: "4" } }).problems).toEqual([
      `before merge: no decision on chant/lifecycle names head ${OTHER.slice(0, 12)} of deploy, so this run applies nothing`,
    ]);
    const other = `sha256:${"0".repeat(64)}`;
    expect(checkJob(rest, { ...at, beforeMerge: { ...run, digest: other }, beforeMergeRecord: record, followOn: { wave: "4" } }).problems).toEqual([
      `before merge: the run carries digest ${other}, and the decision for head ${HEAD.slice(0, 12)} has ${record.digest}`,
    ]);
  });

  test("the rest wave's own number is no follow-on, and a run that is none is checked as before", () => {
    expect(checkJob(rest, { ...at, beforeMerge: run, beforeMergeRecord: record, followOn: { wave: "3" } }).problems).toEqual([]);
    expect(checkJob(rest, { ...at }).checked).toEqual(["ref refs/heads/main"]);
    expect(checkJob(earlier, { ...at }).checked).toEqual(["ref refs/heads/main"]);
  });

  test("a wave that is not after the rest wave, a job of another wave, and a commit beside a decided head are refused", () => {
    expect(checkJob(rest, { ...at, beforeMerge: run, beforeMergeRecord: record, followOn: { wave: "2" } }).problems).toEqual(['follow-on: the run\'s wave "2" is no wave after wave 3']);
    expect(checkJob(rest, { ...at, beforeMerge: run, beforeMergeRecord: record, followOn: { wave: "4; rm -rf /" } }).problems).toEqual(['follow-on: the run\'s wave "4; rm -rf /" is no wave after wave 3']);
    expect(checkJob(earlier, { ...at, beforeMerge: run, beforeMergeRecord: record, followOn: { wave: "4" } }).problems).toEqual([
      "follow-on: the run names wave 4 and commit none, and this job is none of the rest wave's, which alone runs in a follow-on",
    ]);
    expect(checkJob(rest, { ...at, beforeMerge: run, beforeMergeRecord: record, followOn: { wave: "4", commit: PUSHED } }).problems).toEqual([
      `follow-on: a follow-on of a decided head checks out that head, and the run names the commit ${PUSHED} too`,
    ]);
  });

  test("a push's follow-on names the commit it goes on with", () => {
    const r = checkJob(rest, { ...at, followOn: { wave: "4", commit: PUSHED } });
    expect(r.problems).toEqual([]);
    expect(r.checked).toEqual(["ref refs/heads/main", `follow-on wave 4 at ${PUSHED.slice(0, 12)}`]);
    expect(checkJob(rest, { ...at, followOn: { wave: "4" } }).problems).toEqual(["follow-on: a push's follow-on names the commit it goes on with, and the run's none is not a commit sha"]);
    expect(checkJob(rest, { ...at, followOn: { wave: "4", commit: "main" } }).problems).toEqual(['follow-on: a push\'s follow-on names the commit it goes on with, and the run\'s "main" is not a commit sha']);
    expect(checkJob(rest, { ...at, followOn: { commit: PUSHED } }).problems).toEqual([`follow-on: the run names the commit ${PUSHED} and no wave after wave 3, so it is no follow-on`]);
  });

  test("jobGuardSpec carries the rest wave, the parse checks it, and jobSeen reads the variables", async () => {
    expect(jobGuardSpec({ forge: "gitlab", job: "w", branches: ["main"], rest: 3 }).rest).toBe(3);
    expect(() => parseJobGuardSpec(JSON.stringify({ ...rest, rest: "3" }))).toThrow("rest is the rest wave's number");
    const seen = await jobSeen(rest, { GITHUB_REF: "refs/heads/main", CHANT_WAVES_WAVE: " 4 ", CHANT_WAVES_COMMIT: PUSHED });
    expect(seen.followOn).toEqual({ wave: "4", commit: PUSHED });
    expect((await jobSeen(rest, { GITHUB_REF: "refs/heads/main" })).followOn).toBeUndefined();
  });
});

describe("the node -e program agrees in a follow-on run", () => {
  let server = "";
  beforeAll(() => {
    server = mkdtempSync(join(tmpdir(), "chant-guard-follow-on-"));
    const work = mkdtempSync(join(tmpdir(), "chant-guard-follow-on-work-"));
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

  const node = (spec: JobGuardSpec, env: Record<string, string>) =>
    spawnSync(process.execPath, ["-e", JOB_GUARD_JS], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", [JOB_GUARD_ENV]: JSON.stringify(spec), ...env }, encoding: "utf-8" });
  const forgeEnv = (spec: JobGuardSpec): Record<string, string> =>
    spec.forge === "gitlab"
      ? { CI_SERVER_URL: `file://${server}`, CI_PROJECT_PATH: "acme/infra", CI_JOB_TOKEN: "t", CI_COMMIT_REF_NAME: "main", CI_COMMIT_REF_PROTECTED: "true" }
      : { GITHUB_SERVER_URL: `file://${server}`, GITHUB_REPOSITORY: "acme/infra", GITHUB_TOKEN: "t", GITHUB_REF: "refs/heads/main" };
  const decided = { CHANT_BEFORE_MERGE_PR: "7", CHANT_BEFORE_MERGE_HEAD: HEAD, CHANT_BEFORE_MERGE_DIGEST: record.digest };
  const gl: JobGuardSpec = { ...rest, forge: "gitlab" };
  const fj: JobGuardSpec = { ...rest, forge: "forgejo" };

  const cases: Array<[string, JobGuardSpec, Record<string, string>, boolean]> = [
    ["GitHub: a follow-on of the decided head", rest, { ...decided, CHANT_WAVES_WAVE: "4" }, true],
    ["GitLab: a follow-on of the decided head", gl, { ...decided, CHANT_WAVES_WAVE: "5" }, true],
    ["Forgejo: a push's follow-on", fj, { CHANT_WAVES_WAVE: "4", CHANT_WAVES_COMMIT: PUSHED }, true],
    ["GitHub: the rest wave's own number in a run that is none", rest, { ...decided, CHANT_WAVES_WAVE: "3" }, true],
    ["GitHub: a follow-on for another head", rest, { ...decided, CHANT_BEFORE_MERGE_HEAD: OTHER, CHANT_WAVES_WAVE: "4" }, false],
    ["GitLab: a follow-on for another digest", gl, { ...decided, CHANT_BEFORE_MERGE_DIGEST: `sha256:${"0".repeat(64)}`, CHANT_WAVES_WAVE: "4" }, false],
    ["Forgejo: a follow-on in a job of an earlier wave", { ...earlier, forge: "forgejo" }, { ...decided, CHANT_WAVES_WAVE: "4" }, false],
    ["GitHub: a wave before the rest wave", rest, { ...decided, CHANT_WAVES_WAVE: "1" }, false],
    ["GitLab: a push's follow-on with no commit", gl, { CHANT_WAVES_WAVE: "4" }, false],
    ["GitHub: a commit beside a decided head", rest, { ...decided, CHANT_WAVES_WAVE: "4", CHANT_WAVES_COMMIT: PUSHED }, false],
  ];

  for (const [name, spec, extra, ok] of cases) {
    test(name, async () => {
      const env = { ...forgeEnv(spec), ...extra };
      const r = node(spec, env);
      const want = describeJobGuard(spec, checkJob(spec, await jobSeen(spec, { ...process.env, ...env }, (() => Promise.reject(new Error("no fetch"))) as unknown as typeof fetch)));
      expect(want.ok).toBe(ok);
      expect(r.status).toBe(ok ? 0 : CHANT_EXIT.misplaced);
      expect(r.stdout.trim().split("\n").filter(Boolean)).toEqual(want.out);
      expect(r.stderr.trim().split("\n").filter(Boolean)).toEqual(want.err);
    });
  }
});
