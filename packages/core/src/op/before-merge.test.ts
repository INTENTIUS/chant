/**
 * Waves before merge (#4984): the decision on an open pull request, against
 * a real repository with the forge's pull request ref, the record it writes,
 * and the job after the last wave.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CHANT_WORDS } from "../ci-product-words";
import type { PullRequestDetail } from "../pr-forge-reads";
import { beforeMergeDigest, beforeMergeProblems, parseBeforeMerge, renderBeforeMerge, type BeforeMergeDecision, type BeforeMergeRecord } from "./before-merge";
import { decideWavesBeforeMerge, defaultPipelineFiles, touchesPipeline, type DecideBeforeMergeInput } from "./before-merge-decide";
import { beforeMergeDone } from "./before-merge-done";

const words = { ...CHANT_WORDS, product: "terragucci" };

const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

/** An origin with main, a pull request head on refs/pull/7/head, and a clone of main. */
function repos(change: Record<string, string> = { "live/app/main.tf": "2" }) {
  const origin = mkdtempSync(join(tmpdir(), "chant-bmd-origin-"));
  git(origin, "init", "-q", "-b", "main");
  mkdirSync(join(origin, "live/app"), { recursive: true });
  writeFileSync(join(origin, "live/app/main.tf"), "1");
  git(origin, "add", ".");
  git(origin, "commit", "-q", "-m", "base");
  const base = git(origin, "rev-parse", "HEAD");
  git(origin, "checkout", "-q", "-b", "feature");
  for (const [f, text] of Object.entries(change)) {
    mkdirSync(join(origin, f, ".."), { recursive: true });
    writeFileSync(join(origin, f), text);
  }
  git(origin, "add", ".");
  git(origin, "commit", "-q", "-m", "head");
  const head = git(origin, "rev-parse", "HEAD");
  git(origin, "update-ref", "refs/pull/7/head", head);
  git(origin, "checkout", "-q", "main");
  const work = mkdtempSync(join(tmpdir(), "chant-bmd-work-"));
  git(work, "clone", "-q", origin, ".");
  return { origin, work, base, head };
}

const runGit: DecideBeforeMergeInput["git"] = (argv, o) => {
  const r = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", ...(o.cwd ? { cwd: o.cwd } : {}) });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

function input(cwd: string, head: string, over: Partial<DecideBeforeMergeInput> = {}) {
  const log: string[] = [];
  const pr: PullRequestDetail = { number: 7, title: "t", body: "", state: "open", head: "feature", headSha: head, base: "main", sameRepo: true };
  const i: DecideBeforeMergeInput = {
    forge: "github",
    pr,
    user: "alice",
    base: "main",
    op: "tf-apply",
    count: 3,
    jobs: { workflow: "tf-apply.yml", plan: ["terragucci/plan"], pipelineFiles: defaultPipelineFiles("github") },
    words,
    requires: async () => null,
    statuses: async () => [{ context: "terragucci/plan", state: "success" }],
    git: runGit,
    cwd,
    record: async (d: BeforeMergeDecision) => {
      log.push(`record ${d.pr} ${d.head.slice(0, 8)} ${d.through ?? "-"}`);
      return { ...d, digest: beforeMergeDigest("tf-apply", d) };
    },
    stop: async (h, through) => void log.push(`stop ${h.slice(0, 8)} ${through}`),
    start: async (r: BeforeMergeRecord) => {
      log.push(`start ${r.pr} ${r.head.slice(0, 8)} ${r.digest.slice(0, 13)}`);
      return { url: "https://forge/run/1" };
    },
    now: () => "2026-11-10T12:00:00.000Z",
    ...over,
  };
  return { i, log };
}

describe("the decision before merge (#4984)", () => {
  test("a ready pull request is recorded, its stop set, and the waves started for its head", async () => {
    const { work, base, head } = repos();
    const { i, log } = input(work, head, { wave: 2, lock: async (pr, h, b, by) => ({ ok: true, targets: [`${pr}:${h === head}:${b === base}:${by}`] }) });
    const done = await decideWavesBeforeMerge(i);
    expect(done).toEqual({ kind: "ran", text: `started the waves of tf-apply (https://forge/run/1) on pull request 7's head ${head.slice(0, 8)} through wave 2 for alice, holding \`7:true:true:alice\`; each wave's gate decides, and the run says when the head applied`, url: "https://forge/run/1" });
    expect(log).toEqual([`record 7 ${head.slice(0, 8)} 2`, `stop ${head.slice(0, 8)} 2`, `start 7 ${head.slice(0, 8)} sha256:${beforeMergeDigest("tf-apply", { pr: 7, head, base, through: 2, at: "2026-11-10T12:00:00.000Z", by: "alice" }).slice(7, 13)}`]);
  });

  test("an apply of every wave clears the head's stop", async () => {
    const { work, head } = repos();
    const { i, log } = input(work, head);
    await decideWavesBeforeMerge(i);
    expect(log[1]).toBe(`stop ${head.slice(0, 8)} null`);
  });

  test("each refusal says why, and nothing is recorded", async () => {
    const { work, base, head } = repos();
    const cases: Array<[Partial<DecideBeforeMergeInput>, string]> = [
      [{ pr: { number: 7, title: "", body: "", state: "open", head: "f", headSha: head, base: "main", sameRepo: false } }, "a pull request from a fork runs no command"],
      [{ pr: { number: 7, title: "", body: "", state: "open", head: "f", headSha: head, base: "release", sameRepo: true } }, "pull request 7 targets release, not the default branch main"],
      [{ wave: 4 }, "runs in 3 waves, so there is no `wave-4`"],
      [{ pr: { number: 7, title: "", body: "", state: "open", head: "f", headSha: base, base: "main", sameRepo: true } }, `pull request 7 moved while this comment was read (its head is now ${head.slice(0, 8)})`],
      [{ requires: async () => "approved: no approval at this head" }, `pull request 7 is not ready at ${head.slice(0, 8)}, so nothing is applied: approved: no approval at this head`],
      [{ statuses: async () => [{ context: "terragucci/plan", state: "failure" }] }, "the plan of pull request 7 has not passed on its head"],
      [{ lock: async () => ({ ok: false, text: "`live/app` is locked by pull request 9" }) }, "`live/app` is locked by pull request 9"],
    ];
    for (const [over, text] of cases) {
      const { i, log } = input(work, head, over);
      const done = await decideWavesBeforeMerge(i);
      expect(done.kind).toBe("reply");
      expect((done as { text: string }).text).toContain(text);
      expect(log).toEqual([]);
    }
  });

  test("a change to the pipeline's files applies after it merges", async () => {
    const { work, head } = repos({ ".github/workflows/tf-apply.yml": "x" });
    const { i, log } = input(work, head);
    const done = await decideWavesBeforeMerge(i);
    expect(done).toMatchObject({ kind: "reply" });
    expect((done as { text: string }).text).toBe("pull request 7 changes `.github/workflows/tf-apply.yml`, and the apply runs the pipeline of main, so it is not applied before merge. Merge it, then comment `/terragucci apply` on it to apply from the merge commit");
    expect(log).toEqual([]);
    expect(touchesPipeline(".chant/op-waves/tf-apply.spec.json", defaultPipelineFiles("gitlab"))).toBe(true);
    expect(touchesPipeline(".gitlab-ci.yml", defaultPipelineFiles("gitlab"))).toBe(true);
    expect(touchesPipeline("live/app/main.tf", defaultPipelineFiles("gitlab"))).toBe(false);
  });
});

describe("the record (#4984)", () => {
  const d: BeforeMergeDecision = { pr: 7, head: "a".repeat(40), base: "b".repeat(40), at: "2026-11-10T12:00:00.000Z", by: "alice" };
  const r: BeforeMergeRecord = { ...d, digest: beforeMergeDigest("tf-apply", d) };

  test("round-trips, keeps one decision per head, and drops what is not one", () => {
    const text = renderBeforeMerge({ version: 1, heads: { [d.head]: r } });
    expect(parseBeforeMerge(text).heads[d.head]).toEqual(r);
    expect(parseBeforeMerge(JSON.stringify({ version: 1, heads: { [d.head]: { ...r, head: "c".repeat(40) }, nope: r } })).heads).toEqual({});
    expect(parseBeforeMerge("not json").heads).toEqual({});
  });

  test("the digest covers every field, so an edited decision no longer matches", () => {
    expect(beforeMergeProblems("tf-apply", { pr: "7", head: d.head, digest: r.digest }, r)).toEqual([]);
    expect(beforeMergeProblems("other-op", { pr: "7", head: d.head, digest: r.digest }, r)).toHaveLength(1);
    expect(beforeMergeProblems("tf-apply", { pr: "7", head: d.head, digest: r.digest }, { ...r, by: "mallory" })).toEqual([`before merge: the decision for head ${d.head.slice(0, 12)} was changed after it was made: its fields give another digest`]);
  });
});

describe("the job after the last wave (#4984)", () => {
  const d: BeforeMergeDecision = { pr: 7, head: "a".repeat(40), base: "b".repeat(40), at: "2026-11-10T12:00:00.000Z", by: "alice" };
  const record: BeforeMergeRecord = { ...d, digest: beforeMergeDigest("tf-apply", d) };
  const run = { pr: "7", head: d.head, digest: record.digest };
  const forge = (over: Record<string, unknown> = {}) => {
    const said: string[] = [];
    const merges: Array<{ pr: number; sha?: string }> = [];
    const f = {
      kind: "github" as const,
      addComment: async (_pr: number, body: string) => void said.push(body),
      upsertComment: async (_pr: number, _m: string, body: string) => void said.push(body),
      prApproved: async () => ({ passed: true, reason: "approved by bob" }),
      pullRequestHead: async () => ({ open: true, sha: d.head }),
      mergePullRequest: async (pr: number, m: { sha?: string }) => {
        merges.push({ pr, sha: m.sha });
        return { merged: true, sha: "c".repeat(40) };
      },
      ...over,
    };
    return { f, said, merges };
  };
  const applied = { outcome: "applied" as const, applied: ["dev", "prod"], counts: { applied: 2 } };

  test("auto: merges at the decided head and releases the locks", async () => {
    const { f, said, merges } = forge();
    const done = await beforeMergeDone({ op: "tf-apply", waves: 2, run, record, outcome: applied, merge: "auto", forge: f as never, release: async () => ["live/app"], words });
    expect(done).toMatchObject({ code: 0, merged: true });
    expect(merges).toEqual([{ pr: 7, sha: d.head }]);
    expect(said).toEqual([`terragucci: every wave of tf-apply applied pull request 7's head ${d.head.slice(0, 12)}: merged it as ${"c".repeat(12)} and released its locks on live/app`]);
  });

  test("manual says it is ready, a run another head names stops misplaced, and a wave that did not apply merges nothing", async () => {
    const { f, said, merges } = forge();
    expect((await beforeMergeDone({ op: "tf-apply", waves: 2, run, record, outcome: applied, merge: "manual", forge: f as never, release: async () => [], words })).code).toBe(0);
    expect(said.at(-1)).toContain("Merge it when you are ready; its locks hold until it merges or closes");
    expect((await beforeMergeDone({ op: "tf-apply", waves: 2, run: { ...run, head: "e".repeat(40) }, record: undefined, outcome: applied, merge: "auto", forge: f as never, release: async () => [], words })).code).toBe(9);
    const partial = await beforeMergeDone({ op: "tf-apply", waves: 2, run, record, outcome: { outcome: "partial", applied: ["dev"], counts: {} }, merge: "auto", forge: f as never, release: async () => [], words });
    expect(partial.code).toBe(3);
    expect(merges).toEqual([]);
  });

  test("an approval taken back since the decision leaves it open", async () => {
    const { f, merges, said } = forge({ prApproved: async () => ({ passed: false, reason: "the approval was dismissed" }) });
    const done = await beforeMergeDone({ op: "tf-apply", waves: 2, run, record, outcome: applied, merge: "auto", forge: f as never, release: async () => [], words });
    expect(done).toMatchObject({ code: 3, merged: false });
    expect(merges).toEqual([]);
    expect(said.at(-1)).toContain("it is not approved at that head (the approval was dismissed)");
  });
});
