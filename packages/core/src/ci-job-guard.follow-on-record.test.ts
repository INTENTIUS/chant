/**
 * #4998: the guard admits a follow-on run only for the wave the newest
 * record job of its chain started, as its record on `chant/lifecycle`
 * names it. A wave started by hand past it (wave N+3 of a chain at N+1),
 * or an earlier wave run again after the chain went on, is refused, on
 * each forge, by checkJob and by the `node -e` program alike.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { checkJob, describeJobGuard, JOB_GUARD_ENV, JOB_GUARD_JS, jobSeen, type JobGuardForge, type JobGuardSpec } from "./ci-job-guard";
import { CHANT_EXIT } from "./exit-codes";
import { beforeMergeDigest, beforeMergePath, renderBeforeMerge, type BeforeMergeRecord } from "./op/before-merge";
import { followOnPath, followOnRecordProblems, parseFollowOn, renderFollowOn, type FollowOnRecord } from "./op/follow-on-run";

const HEAD = "a".repeat(40);
const BASE = "c".repeat(40);
const PUSHED = "d".repeat(40);
const UNRECORDED = "e".repeat(40);
const decision = { pr: 7, head: HEAD, base: BASE, at: "2026-11-10T12:00:00.000Z", by: "alice" };
const record: BeforeMergeRecord = { ...decision, digest: beforeMergeDigest("deploy", decision) };
const decided = { CHANT_BEFORE_MERGE_PR: "7", CHANT_BEFORE_MERGE_HEAD: HEAD, CHANT_BEFORE_MERGE_DIGEST: record.digest };

// The rest wave is wave 3 (N); its record job started wave 4 (N+1), which is where each chain stands.
const chained = (key: string, wave: number, extra: Partial<FollowOnRecord> = {}): FollowOnRecord => ({ key, wave, from: wave - 1, run: "41", at: "2026-11-10T12:30:00.000Z", outcomes: { vpc: { status: "applied", wave: 3, at: "2026-11-10T12:20:00.000Z" } }, ...extra });
const headChain = chained(HEAD, 4, { pr: 7, digest: record.digest });
const pushChain = chained(PUSHED, 4, { commit: PUSHED });
const restOn = (forge: JobGuardForge): JobGuardSpec => ({ forge, job: "the plan job of wave 3 (rest) of deploy", branches: ["main"], beforeMerge: { op: "deploy" }, rest: 3 });

describe("the follow-on records (#4998)", () => {
  test("parse keeps a well-formed entry, drops a malformed one, and renders the newest chains", () => {
    const text = renderFollowOn({ version: 1, chains: { [HEAD]: headChain, [PUSHED]: pushChain } });
    expect(parseFollowOn(text).chains).toEqual({ [HEAD]: headChain, [PUSHED]: pushChain });
    const bad = JSON.stringify({ version: 1, chains: { [HEAD]: { ...headChain, wave: 1 }, [PUSHED]: { ...pushChain, key: HEAD }, main: pushChain } });
    expect(parseFollowOn(bad).chains).toEqual({});
    expect(parseFollowOn("not json").chains).toEqual({});
    expect(followOnPath("deploy")).toBe("_waves/deploy.follow-on.json");
  });

  test("the lines: no record, another wave, another decision", () => {
    expect(followOnRecordProblems("deploy", "4", HEAD, record.digest, headChain)).toEqual([]);
    expect(followOnRecordProblems("deploy", "6", HEAD, record.digest, headChain)).toEqual([`follow-on: the newest record job of deploy for head ${HEAD.slice(0, 12)} started wave 4, and this run names wave 6`]);
    expect(followOnRecordProblems("deploy", "4", UNRECORDED, undefined, null)).toEqual([`follow-on: no record job of deploy started a follow-on for commit ${UNRECORDED.slice(0, 12)}, so this run applies nothing`]);
  });
});

describe("checkJob refuses a follow-on its chain's record does not name (#4998)", () => {
  const at = { ref: "refs/heads/main" };
  for (const forge of ["github", "gitlab", "forgejo"] as const) {
    const seenAt = forge === "gitlab" ? { ref: "main", refProtected: "true" } : at;
    test(`${forge}: a wave started by hand past the chain's (wave 6 of a chain at wave 4) is refused`, () => {
      const r = checkJob(restOn(forge), { ...seenAt, beforeMerge: { pr: "7", head: HEAD, digest: record.digest }, beforeMergeRecord: record, followOn: { wave: "6" }, followOnRecord: headChain });
      expect(r.problems).toEqual([`follow-on: the newest record job of deploy for head ${HEAD.slice(0, 12)} started wave 4, and this run names wave 6`]);
      expect(r.checked).not.toContain("follow-on wave 6");
      const push = checkJob(restOn(forge), { ...seenAt, followOn: { wave: "6", commit: PUSHED }, followOnRecord: pushChain });
      expect(push.problems).toEqual([`follow-on: the newest record job of deploy for commit ${PUSHED.slice(0, 12)} started wave 4, and this run names wave 6`]);
    });
  }

  test("an earlier wave run again once the chain went on is refused; the wave the record names is admitted", () => {
    const moved = chained(PUSHED, 5, { commit: PUSHED });
    expect(checkJob(restOn("github"), { ...at, followOn: { wave: "4", commit: PUSHED }, followOnRecord: moved }).problems).toEqual([
      `follow-on: the newest record job of deploy for commit ${PUSHED.slice(0, 12)} started wave 5, and this run names wave 4`,
    ]);
    expect(checkJob(restOn("github"), { ...at, followOn: { wave: "5", commit: PUSHED }, followOnRecord: moved }).checked).toContain(`follow-on wave 5 at ${PUSHED.slice(0, 12)}`);
  });

  test("records that cannot be read refuse the run, and a run that is no follow-on reads none", async () => {
    expect(checkJob(restOn("github"), { ...at, followOn: { wave: "4", commit: PUSHED }, followOnError: "could not fetch chant/lifecycle: denied" }).problems).toEqual([
      "follow-on: the follow-on records on chant/lifecycle could not be read: could not fetch chant/lifecycle: denied",
    ]);
    const reads: string[] = [];
    const reader = (_f: JobGuardForge, _e: NodeJS.ProcessEnv, path: string) => (reads.push(path), null);
    await jobSeen(restOn("github"), { GITHUB_REF: "refs/heads/main", CHANT_WAVES_WAVE: "3" }, fetch, reader);
    await jobSeen(restOn("github"), { GITHUB_REF: "refs/heads/main", CHANT_WAVES_WAVE: "2", CHANT_WAVES_COMMIT: PUSHED }, fetch, reader);
    expect(reads).toEqual([]);
    const seen = await jobSeen(restOn("github"), { GITHUB_REF: "refs/heads/main", CHANT_WAVES_WAVE: "4", CHANT_WAVES_COMMIT: PUSHED }, fetch, reader);
    expect(reads).toEqual(["_waves/deploy.follow-on.json"]);
    expect(seen.followOnRecord).toBeNull();
  });
});

describe("the node -e program agrees on each forge (#4998)", () => {
  let server = "";
  beforeAll(() => {
    server = mkdtempSync(join(tmpdir(), "chant-guard-follow-on-record-"));
    const work = mkdtempSync(join(tmpdir(), "chant-guard-follow-on-record-work-"));
    const git = (cwd: string, ...args: string[]) => {
      const r = spawnSync("git", args, { cwd, encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
      if (r.status !== 0) throw new Error(r.stderr);
    };
    mkdirSync(join(server, "acme"), { recursive: true });
    git(join(server, "acme"), "init", "-q", "--bare", "infra.git");
    git(work, "init", "-q", "-b", "chant/lifecycle");
    mkdirSync(join(work, "_waves"));
    writeFileSync(join(work, beforeMergePath("deploy")), renderBeforeMerge({ version: 1, heads: { [HEAD]: record } }));
    writeFileSync(join(work, followOnPath("deploy")), renderFollowOn({ version: 1, chains: { [HEAD]: headChain, [PUSHED]: pushChain } }));
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "decide and follow on");
    git(work, "push", "-q", join(server, "acme", "infra.git"), "chant/lifecycle");
  });

  const node = (spec: JobGuardSpec, env: Record<string, string>) =>
    spawnSync(process.execPath, ["-e", JOB_GUARD_JS], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", [JOB_GUARD_ENV]: JSON.stringify(spec), ...env }, encoding: "utf-8" });
  const forgeEnv = (forge: JobGuardForge): Record<string, string> =>
    forge === "gitlab"
      ? { CI_SERVER_URL: `file://${server}`, CI_PROJECT_PATH: "acme/infra", CI_JOB_TOKEN: "t", CI_COMMIT_REF_NAME: "main", CI_COMMIT_REF_PROTECTED: "true" }
      : { GITHUB_SERVER_URL: `file://${server}`, GITHUB_REPOSITORY: "acme/infra", GITHUB_TOKEN: "t", GITHUB_REF: "refs/heads/main" };

  const cases: Array<[string, JobGuardForge, Record<string, string>, boolean]> = [];
  for (const forge of ["github", "gitlab", "forgejo"] as const) {
    cases.push(
      [`${forge}: the wave the record job started, of the decided head`, forge, { ...decided, CHANT_WAVES_WAVE: "4" }, true],
      [`${forge}: a wave started by hand past it, of the decided head`, forge, { ...decided, CHANT_WAVES_WAVE: "6" }, false],
      [`${forge}: the wave the record job started, of a push`, forge, { CHANT_WAVES_WAVE: "4", CHANT_WAVES_COMMIT: PUSHED }, true],
      [`${forge}: a wave started by hand past it, of a push`, forge, { CHANT_WAVES_WAVE: "6", CHANT_WAVES_COMMIT: PUSHED }, false],
      [`${forge}: a push no record job followed on`, forge, { CHANT_WAVES_WAVE: "4", CHANT_WAVES_COMMIT: UNRECORDED }, false],
    );
  }

  for (const [name, forge, extra, ok] of cases) {
    test(name, async () => {
      const spec = restOn(forge);
      const env = { ...forgeEnv(forge), ...extra };
      const r = node(spec, env);
      const want = describeJobGuard(spec, checkJob(spec, await jobSeen(spec, { ...process.env, ...env }, (() => Promise.reject(new Error("no fetch"))) as unknown as typeof fetch)));
      expect(want.ok).toBe(ok);
      expect(r.status).toBe(ok ? 0 : CHANT_EXIT.misplaced);
      expect(r.stdout.trim().split("\n").filter(Boolean)).toEqual(want.out);
      expect(r.stderr.trim().split("\n").filter(Boolean)).toEqual(want.err);
      if (!ok) expect(want.err[0]).toMatch(/follow-on: (the newest record job of deploy .* started wave 4, and this run names wave 6|no record job of deploy started a follow-on)/);
    });
  }
});
