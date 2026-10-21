/**
 * #4095: `chant ci serve` polls the forge and runs `ci run` plan for each new
 * pull request head and apply for each new target-branch commit, deduped in
 * a state file, one apply per group through a git-ref lease, with each
 * apply's resume record kept on the host, and at most `maxJobs` at once.
 *
 * Every test works in its own temp repository with a bare origin. The forge
 * is a fake client, and the jobs' `chant` is a stub script outside the
 * repository. Each test runs single `--once` passes in-process.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, declaration, git, repoFixture, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import { ciServeInterval, ciServeKey, ciServePass, formatCiServeEvent, readCiServeState, type CiServeEvent, type CiServeForge, type CiServeOptions } from "./ci-serve";
import { ciRun, type CiRunResult } from "./ci-run";
import { acquireLease, releaseLease } from "../lifecycle/lease";
import { prApplyGroup, prApplyRecordKey } from "../components/pr-pipeline";
import { parseArgs } from "../cli/parse-args";
import { forgejoForge, githubForge, type ForgeFetch, type OpenPullRequest } from "../pr-forge";

afterAll(cleanScratch);

function commit(root: string, file: string, message = file): string {
  writeFiles(root, { [file]: `${file} ${Math.random()}\n` });
  for (const args of [["add", "-A"], ["commit", "-q", "-m", message]]) {
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "ignore" });
  }
  return git(root, "rev-parse", "HEAD");
}

/** The repository every test starts from, built once: a checkout on main with a bare origin and member `app`. */
const workspaceTemplate = repoFixture(() => {
  const top = scratchDir("chant-ci-serve-template-");
  const origin = join(top, "origin");
  const root = join(top, "root");
  mkdirSync(origin);
  mkdirSync(root);
  git(origin, "init", "-q", "--bare");
  git(root, "init", "-q");
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  writeFiles(root, {
    "chant.workspace.json": declaration([{ name: "app", dir: "app", kind: "other", because: "the app" }]),
    ".gitignore": ".chant/pr/\n.chant/pr-resume/\n",
    "app/a.txt": "a\n",
  });
  git(root, "remote", "add", "origin", origin);
  commit(root, "app/init.txt");
  git(root, "push", "-q", "origin", "main");
  return top;
}, "chant-ci-serve-");

/** A copy of the template, its origin pointed at the copy of the bare one. */
function workspace(): { root: string; app: string; main: string; origin: string } {
  const top = workspaceTemplate();
  const root = join(top, "root");
  const origin = join(top, "origin");
  git(root, "remote", "set-url", "origin", origin);
  return { root, app: join(root, "app"), main: git(root, "rev-parse", "HEAD"), origin };
}

/** A pull request's head commit, on a branch off main, pushed to the forge's refs/pull/<n>/head. */
function pullHead(root: string, n: number): string {
  git(root, "checkout", "-q", "-b", `pr-${n}`);
  const sha = commit(root, `app/pr-${n}.txt`);
  git(root, "push", "-q", "origin", `${sha}:refs/pull/${n}/head`);
  git(root, "checkout", "-q", "main");
  return sha;
}

/**
 * A stand-in for `chant` that keeps its arguments under `.chant/pr` and exits
 * `$FAKE_EXIT`. As `pr-apply` it copies the resume record it was given to
 * `.chant/pr/resume-in.json` and writes a new one naming `$FAKE_ATTEMPT`.
 */
function fakeChant(): string {
  const file = join(scratchDir("chant-ci-serve-bin-"), "chant");
  writeFileSync(
    file,
    [
      "#!/bin/sh",
      'stage="$2"',
      "mkdir -p .chant/pr",
      'printf "%s\\n" "$@" > ".chant/pr/$stage.args"',
      'if [ "$stage" = pr-apply ]; then',
      "  if [ -f .chant/pr-resume/pr-apply.json ]; then cp .chant/pr-resume/pr-apply.json .chant/pr/resume-in.json; fi",
      "  mkdir -p .chant/pr-resume",
      '  echo "{\\"attempt\\": \\"${FAKE_ATTEMPT:-1}\\"}" > .chant/pr-resume/pr-apply.json',
      "fi",
      'if [ -n "$FAKE_SLEEP" ]; then sleep "$FAKE_SLEEP"; fi',
      'exit "${FAKE_EXIT:-0}"',
      "",
    ].join("\n"),
  );
  chmodSync(file, 0o755);
  return file;
}

/** A forge whose open pull requests and branch head the test sets. */
function fakeForge(head: string): CiServeForge & { head: string; prs: OpenPullRequest[]; polls: number; merges: Map<string, number | "throw">; asked: string[] } {
  const f = {
    head,
    merges: new Map<string, number | "throw">(),
    asked: [] as string[],
    async pullRequestFor(sha: string) {
      f.asked.push(sha);
      const n = f.merges.get(sha);
      if (n === "throw") throw new Error("forge unavailable");
      return n ?? null;
    },
    prs: [] as OpenPullRequest[],
    polls: 0,
    async openPullRequests(base: string) {
      f.polls++;
      return f.prs.filter((p) => p.base === base);
    },
    async branchHead(branch: string) {
      return branch === "main" ? f.head : undefined;
    },
  };
  return f;
}

const pr = (number: number, headSha: string, baseSha: string, extra: Partial<OpenPullRequest> = {}): OpenPullRequest => ({ number, head: `pr-${number}`, headSha, base: "main", baseSha, author: "driver", fork: false, ...extra });

const HOST = { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_TOKEN: "forge-token", GITHUB_SERVER_URL: "http://forgejo.localhost", GITHUB_API_URL: "http://forgejo.localhost/api/v1" };

function serve(app: string, client: CiServeForge, extra: Partial<CiServeOptions> & { hostEnv?: Record<string, string | undefined> } = {}): { opts: CiServeOptions; events: CiServeEvent[]; state: string } {
  const state = extra.stateDir ?? scratchDir("chant-ci-serve-state-");
  const events: CiServeEvent[] = [];
  const { hostEnv, ...rest } = extra;
  const env = { ...HOST, ...hostEnv };
  return {
    state,
    events,
    opts: {
      cwd: app,
      forge: "forgejo",
      repo: "demo/estate",
      env: "prod",
      client,
      stateDir: state,
      holder: "serve-test",
      // Most tests here cover the apply on merge, which #4168 made opt-in; the record tests pass false.
      applyOnMerge: true,
      // A job image of its own, so no setup line downloads OpenTofu.
      job: { image: "chant-ci-serve-test:local", chant: fakeChant(), hostEnv: env, passEnv: Object.keys(hostEnv ?? {}) },
      log: (e) => events.push(e),
      ...rest,
    },
  };
}

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** A commit on no branch, with `parent` when given, as a ledger commit stands in. */
const ledgerCommit = (root: string, message: string, parent?: string): string => git(root, "commit-tree", EMPTY_TREE, ...(parent ? ["-p", parent] : []), "-m", message);

/** Seed `chant/lifecycle` in the clone and on the forge, as an earlier apply left it. */
function seedLedger(root: string): string {
  const seed = ledgerCommit(root, "seed");
  git(root, "update-ref", "refs/heads/chant/lifecycle", seed);
  git(root, "push", "-q", "origin", "chant/lifecycle");
  expect(git(root, "rev-parse", "refs/remotes/origin/chant/lifecycle")).toBe(seed);
  return seed;
}

const isAncestor = (cwd: string, a: string, b: string): boolean => {
  try {
    git(cwd, "merge-base", "--is-ancestor", a, b);
    return true;
  } catch {
    return false;
  }
};

const argsOf = (report: string, stage: string): string[] => readFileSync(join(report, `${stage}.args`), "utf-8").trimEnd().split("\n");
const ofType = <T extends CiServeEvent["type"]>(events: CiServeEvent[], type: T) => events.filter((e): e is Extract<CiServeEvent, { type: T }> => e.type === type);

describe("ci serve records each merge unless apply on merge is opted in (#4168)", () => {
  test("a merge to the target branch gets the record job, measured from the head before it, and no resume record", async () => {
    const { root, app, main } = workspace();
    const forge = fakeForge(main);
    const { opts, events, state } = serve(app, forge, { applyOnMerge: false });
    await ciServePass(opts);
    const merged = commit(root, "app/merged.txt");
    git(root, "push", "-q", "origin", "main");
    forge.head = merged;
    forge.merges.set(merged, 21);

    const pass = await ciServePass(opts);
    expect(pass.jobs).toEqual([expect.objectContaining({ job: "record", commit: merged, base: main, pr: 21, status: "ok" })]);
    const argv = argsOf(pass.jobs[0]!.report!, "pr-record");
    expect(argv.slice(0, 4)).toEqual(["components", "pr-record", "--base", main]);
    expect(argv).not.toContain("--resume");
    expect(ofType(events, "started")[0]).not.toHaveProperty("resume");
    expect(existsSync(join(state, "resume"))).toBe(false);
    const saved = readCiServeState(join(state, `${prApplyGroup("prod", "app")}.json`), { forge: "forgejo", repo: "demo/estate", env: "prod", branch: "main" });
    expect(saved.target).toBe(merged);
    expect(saved.jobs[ciServeKey({ job: "record", commit: merged })]).toMatchObject({ status: "ok" });
    expect((await ciServePass(opts)).jobs).toEqual([]);
  });

  test("each settled job runs the tick, and a tick that fails is an error event, never a failed job", async () => {
    const { root, app, main } = workspace();
    const forge = fakeForge(main);
    const ticks: string[] = [];
    let fail = false;
    const { opts, events } = serve(app, forge, {
      applyOnMerge: false,
      tick: async () => {
        ticks.push("tick");
        if (fail) throw new Error("forge said no");
        return ["ci/green/abc"];
      },
    });
    await ciServePass(opts);
    expect(ticks).toEqual([]);
    const merged = commit(root, "app/merged.txt");
    git(root, "push", "-q", "origin", "main");
    forge.head = merged;
    await ciServePass(opts);
    expect(ticks).toEqual(["tick"]);
    expect(ofType(events, "tick")).toEqual([{ type: "tick", made: ["ci/green/abc"] }]);
    expect(formatCiServeEvent({ type: "tick", made: ["ci/green/abc"] })).toBe("ci tick made ci/green/abc");

    fail = true;
    const next = commit(root, "app/next.txt");
    git(root, "push", "-q", "origin", "main");
    forge.head = next;
    const pass = await ciServePass(opts);
    expect(pass.jobs[0]).toMatchObject({ job: "record", status: "ok" });
    expect(ofType(events, "error").map((e) => e.message)).toContain("ci tick after a job settled: forge said no");
  });
});

describe("chant ci serve (#4095)", () => {
  test("one poll plans a new pull request head once, and skips forks and authors not given", async () => {
    const { root, app, main } = workspace();
    const head = pullHead(root, 1);
    const forge = fakeForge(main);
    forge.prs = [pr(1, head, main), pr(2, head, main, { fork: true }), pr(3, head, main, { author: "stranger" })];
    const { opts, events, state } = serve(app, forge, { authors: ["Driver"] });

    const first = await ciServePass(opts);
    expect(first.jobs).toHaveLength(1);
    expect(first.jobs[0]).toMatchObject({ job: "plan", pr: 1, commit: head, base: main, status: "ok", attempts: 1 });
    expect(ofType(events, "baseline")).toEqual([{ type: "baseline", commit: main }]);
    expect(ofType(events, "skipped").map((e) => [e.pr, e.reason])).toEqual([[2, "fork"], [3, "author"]]);
    const argv = argsOf(first.jobs[0]!.report!, "pr-plan");
    expect(argv.slice(0, 5)).toEqual(["components", "pr-plan", "--base", main, "--pr"]);
    expect(argv[5]).toBe("1");
    expect(argv).toContain("--member");

    const group = prApplyGroup("prod", "app");
    const file = join(state, `${group}.json`);
    const saved = readCiServeState(file, { forge: "forgejo", repo: "demo/estate", env: "prod", branch: "main" });
    expect(saved.target).toBe(main);
    expect(saved.jobs[ciServeKey({ job: "plan", pr: 1, commit: head })]).toMatchObject({ status: "ok" });

    // The same head again: nothing runs.
    const second = await ciServePass(opts);
    expect(second.jobs).toEqual([]);
    expect(ofType(second.events, "started")).toEqual([]);
    expect(forge.polls).toBe(2);
  });

  test("a merge to the target branch applies the new commit, measured from the head before it", async () => {
    const { root, app, main } = workspace();
    const forge = fakeForge(main);
    const { opts, events } = serve(app, forge);
    expect((await ciServePass(opts)).jobs).toEqual([]);
    expect(ofType(events, "baseline")).toHaveLength(1);

    const merged = commit(root, "app/merged.txt");
    git(root, "push", "-q", "origin", "main");
    forge.head = merged;
    const pass = await ciServePass(opts);
    expect(pass.jobs).toEqual([expect.objectContaining({ job: "apply", commit: merged, base: main, status: "ok" })]);
    const argv = argsOf(pass.jobs[0]!.report!, "pr-apply");
    expect(argv.slice(0, 4)).toEqual(["components", "pr-apply", "--base", main]);
    expect(argv.slice(-2)).toEqual(["--resume", ".chant/pr-resume/pr-apply.json"]);
    // The run was recorded on chant/lifecycle and pushed.
    expect(git(root, "ls-remote", "origin", "chant/lifecycle")).toContain(git(root, "rev-parse", "chant/lifecycle"));

    expect((await ciServePass(opts)).jobs).toEqual([]);
  });

  test("an apply gets the number of the pull request whose merge commit it is (#4112)", async () => {
    const { root, app, main } = workspace();
    const forge = fakeForge(main);
    const seen: Array<number | undefined> = [];
    const { opts } = serve(app, forge, { run: (req) => (seen.push(req.pr), ciRun(req)) });
    await ciServePass(opts);
    const merged = commit(root, "app/merged.txt");
    git(root, "push", "-q", "origin", "main");
    forge.head = merged;
    forge.merges.set(merged, 17);

    const pass = await ciServePass(opts);
    expect(forge.asked).toEqual([merged]);
    expect(pass.jobs).toEqual([expect.objectContaining({ job: "apply", commit: merged, pr: 17, status: "ok" })]);
    expect(seen).toEqual([17]);
  });

  /** A serve over a repository whose baseline pass is done, with the `pr` each run was asked for in `seen`. */
  async function mergeWithoutPr() {
    const { root, app, main } = workspace();
    const forge = fakeForge(main);
    const seen: Array<number | undefined> = [];
    const { opts } = serve(app, forge, { run: (req) => (seen.push(req.pr), ciRun(req)) });
    await ciServePass(opts);
    return { root, forge, seen, opts };
  }

  test("an apply with no pull request found runs without --pr (#4112)", async () => {
    const { root, forge, seen, opts } = await mergeWithoutPr();
    const direct = commit(root, "app/direct.txt");
    git(root, "push", "-q", "origin", "main");
    forge.head = direct;
    const pass = await ciServePass(opts);
    expect(pass.jobs).toEqual([expect.objectContaining({ job: "apply", commit: direct, status: "ok" })]);
    expect(pass.jobs[0]!.pr).toBeUndefined();
    expect(seen).toEqual([undefined]);
  });

  test("an apply whose pull request lookup fails runs without --pr (#4112)", async () => {
    const { root, forge, seen, opts } = await mergeWithoutPr();
    const broken = commit(root, "app/broken.txt");
    git(root, "push", "-q", "origin", "main");
    forge.head = broken;
    forge.merges.set(broken, "throw");
    const pass = await ciServePass(opts);
    expect(pass.jobs).toEqual([expect.objectContaining({ job: "apply", commit: broken, status: "ok" })]);
    expect(pass.jobs[0]!.pr).toBeUndefined();
    expect(seen).toEqual([undefined]);
  });

  test("the forge clients look a merge commit up with one GET each (#4112)", async () => {
    const sha = "c".repeat(40);
    const calls: string[] = [];
    const fetch = (body: unknown): ForgeFetch => async (url, init) => {
      calls.push(`${init.method} ${new URL(url).pathname}`);
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    const gh: CiServeForge = githubForge({ apiBase: "https://api.github.com", repo: "demo/estate", token: "t", fetch: fetch([{ number: 5, merged_at: "2026-10-01T00:00:00Z", merge_commit_sha: sha }]) }) as unknown as CiServeForge;
    expect(await gh.pullRequestFor!(sha)).toBe(5);
    const fj: CiServeForge = forgejoForge({ apiBase: "http://forgejo.localhost/api/v1", host: "forgejo.localhost", repo: "demo/estate", token: "t", fetch: fetch({ number: 6 }) }) as unknown as CiServeForge;
    expect(await fj.pullRequestFor!(sha)).toBe(6);
    expect(calls).toEqual([`GET /repos/demo/estate/commits/${sha}/pulls`, `GET /api/v1/repos/demo/estate/commits/${sha}/pull`]);
  });

  test("the group's lease held elsewhere holds the apply until it is released", async () => {
    const { root, app, main } = workspace();
    const forge = fakeForge(main);
    const { opts, events } = serve(app, forge);
    await ciServePass(opts);
    const merged = commit(root, "app/merged.txt");
    git(root, "push", "-q", "origin", "main");
    forge.head = merged;

    const group = prApplyGroup("prod", "app");
    const other = await acquireLease(group, "other-host", { cwd: app, mode: "claim", requirePush: true });
    expect(other.acquired).toBe(true);
    const held = await ciServePass(opts);
    expect(held.jobs).toEqual([]);
    expect(ofType(events, "held")).toEqual([{ type: "held", job: "apply", commit: merged, reason: "lease", heldBy: "other-host" }]);
    expect(formatCiServeEvent(ofType(events, "held")[0]!)).toContain("the apply lease is held by other-host");

    expect(await releaseLease(group, "other-host", other.lease!.token, { cwd: app })).toBe(true);
    const ran = await ciServePass(opts);
    expect(ran.jobs).toEqual([expect.objectContaining({ job: "apply", commit: merged, base: main, status: "ok" })]);
    // The serve released its own lease after the apply.
    expect((await acquireLease(group, "after", { cwd: app, mode: "claim" })).acquired).toBe(true);
  });

  describe("a failed apply", () => {
    // The failing apply runs once in beforeAll, and the two tests read what it left, so no test
    // runs two jobs. A file's beforeAll is not counted in the unit budget (#2817).
    let w: ReturnType<typeof workspace>;
    let forge: ReturnType<typeof fakeForge>;
    let failing: ReturnType<typeof serve>;
    let merged: string;
    let failed: Awaited<ReturnType<typeof ciServePass>>;
    let record: string;

    beforeAll(async () => {
      w = workspace();
      forge = fakeForge(w.main);
      failing = serve(w.app, forge, { hostEnv: { FAKE_EXIT: "3", FAKE_ATTEMPT: "1" } });
      await ciServePass(failing.opts);
      merged = commit(w.root, "app/merged.txt");
      git(w.root, "push", "-q", "origin", "main");
      forge.head = merged;
      failed = await ciServePass(failing.opts);
      record = join(failing.state, "resume", `${prApplyRecordKey("prod", merged, "app")}.json`);
    });

    test("stays failed, and keeps its resume record", async () => {
      expect(failed.jobs).toEqual([expect.objectContaining({ job: "apply", status: "fail", attempts: 1, failure: expect.stringContaining("command-failed") })]);
      expect(JSON.parse(readFileSync(record, "utf-8"))).toEqual({ attempt: "1" });
      expect(existsSync(join(failed.jobs[0]!.report!, "resume-in.json"))).toBe(false);

      // Without --rerun-failed the failed apply is not run again.
      expect((await ciServePass(failing.opts)).jobs).toEqual([]);
    });

    test("--rerun-failed runs it again with its resume record", async () => {
      const retry = serve(w.app, forge, { stateDir: failing.state, rerunFailed: true, hostEnv: { FAKE_EXIT: "0", FAKE_ATTEMPT: "2" } });
      const again = await ciServePass(retry.opts);
      expect(again.jobs).toEqual([expect.objectContaining({ job: "apply", commit: merged, base: w.main, status: "ok", attempts: 2 })]);
      expect(ofType(retry.events, "started")[0]).toMatchObject({ attempt: 2, resume: record });
      // The job read the first attempt's record, and left its own.
      expect(JSON.parse(readFileSync(join(again.jobs[0]!.report!, "resume-in.json"), "utf-8"))).toEqual({ attempt: "1" });
      expect(JSON.parse(readFileSync(record, "utf-8"))).toEqual({ attempt: "2" });
      // A passed apply is not run again, --rerun-failed or not.
      expect((await ciServePass(retry.opts)).jobs).toEqual([]);
    });
  });

  test("--max-jobs holds the jobs over the limit for the next poll", async () => {
    const { root, app, main } = workspace();
    const one = pullHead(root, 1);
    const two = pullHead(root, 2);
    const forge = fakeForge(main);
    forge.prs = [pr(1, one, main), pr(2, two, main)];
    const { opts, events } = serve(app, forge, { maxJobs: 1 });

    const first = await ciServePass(opts);
    expect(first.jobs.map((j) => [j.pr, j.status])).toEqual([[1, "ok"]]);
    expect(ofType(events, "held")).toEqual([{ type: "held", job: "plan", commit: two, pr: 2, reason: "capacity" }]);

    const second = await ciServePass(opts);
    expect(second.jobs.map((j) => [j.pr, j.status])).toEqual([[2, "ok"]]);
    expect((await ciServePass(opts)).jobs).toEqual([]);
  });

  test("the command line takes the repository, the limit, the authors and the interval", () => {
    const args = parseArgs(["ci", "serve", "--forge", "forgejo", "--repo", "demo/estate", "--env", "local", "--max-jobs", "2", "--author", "a", "--author", "b", "--state", "/tmp/s", "--once", "--rerun-failed", "--interval", "45"]);
    expect(args).toMatchObject({ command: "ci", path: "serve", forge: "forgejo", ciRepo: "demo/estate", env: "local", maxJobs: 2, ciAuthors: ["a", "b"], statePath: "/tmp/s", once: true, rerunFailed: true, interval: "45" });
    expect(() => parseArgs(["ci", "serve", "--repo", "estate"])).toThrow(/owner\/name/);
    expect(() => parseArgs(["ci", "serve", "--max-jobs", "0"])).toThrow(/1 or more/);
    expect(ciServeInterval(undefined)).toBe(30_000);
    expect(ciServeInterval("45")).toBe(45_000);
    expect(ciServeInterval("2m")).toBe(120_000);
    expect(() => ciServeInterval("0")).toThrow(/a second or more/);
  });
});

describe("ci serve follows the forge's chant/lifecycle (#4121)", () => {
  /** A serve past its baseline pass, with one merge waiting to apply, and each run's result in `results`. */
  async function mergeWaiting() {
    const w = workspace();
    const seed = seedLedger(w.root);
    const forge = fakeForge(w.main);
    const results: CiRunResult[] = [];
    const { opts, events } = serve(w.app, forge, { run: async (req) => { const r = await ciRun(req); results.push(r); return r; } });
    await ciServePass(opts);
    const merged = commit(w.root, "app/merged.txt");
    git(w.root, "push", "-q", "origin", "main");
    forge.head = merged;
    return { ...w, seed, opts, events, results };
  }

  test("a ledger the forge deleted is deleted here, and the next apply runs clean", async () => {
    const { root, origin, seed, opts, events, results } = await mergeWaiting();
    git(origin, "update-ref", "-d", "refs/heads/chant/lifecycle");

    const pass = await ciServePass(opts);
    expect(ofType(events, "ledger")).toEqual([{ type: "ledger", action: "deleted", local: seed }]);
    expect(formatCiServeEvent(ofType(events, "ledger")[0]!)).toContain("was deleted");
    expect(pass.jobs).toEqual([expect.objectContaining({ job: "apply", status: "ok" })]);
    expect(results[0]).toMatchObject({ pushed: true });
    const tip = git(origin, "rev-parse", "refs/heads/chant/lifecycle");
    expect(git(root, "rev-parse", "chant/lifecycle")).toBe(tip);
    expect(isAncestor(origin, seed, tip)).toBe(false);
  });

  test("a ledger the forge rewrote is reset to the forge's and not pushed back", async () => {
    const { root, origin, seed, opts, events, results } = await mergeWaiting();
    const rewritten = ledgerCommit(root, "rewritten");
    git(root, "push", "-q", "origin", `${rewritten}:refs/scratch/rewritten`);
    git(origin, "update-ref", "refs/heads/chant/lifecycle", rewritten);

    const pass = await ciServePass(opts);
    expect(ofType(events, "ledger")).toEqual([{ type: "ledger", action: "reset", local: seed, forge: rewritten }]);
    expect(pass.jobs).toEqual([expect.objectContaining({ job: "apply", status: "ok" })]);
    expect(results[0]).toMatchObject({ pushed: true });
    const tip = git(origin, "rev-parse", "refs/heads/chant/lifecycle");
    expect(isAncestor(origin, rewritten, tip)).toBe(true);
    expect(isAncestor(root, seed, tip)).toBe(false);
  });

  test("a ledger ahead of the forge's keeps its facts, and the apply pushes them", async () => {
    const { root, origin, seed, opts, events, results } = await mergeWaiting();
    const ahead = ledgerCommit(root, "unpushed fact", seed);
    git(root, "update-ref", "refs/heads/chant/lifecycle", ahead);

    const pass = await ciServePass(opts);
    expect(ofType(events, "ledger")).toEqual([]);
    expect(pass.jobs).toEqual([expect.objectContaining({ job: "apply", status: "ok" })]);
    expect(results[0]).toMatchObject({ pushed: true });
    expect(isAncestor(origin, ahead, git(origin, "rev-parse", "refs/heads/chant/lifecycle"))).toBe(true);
  });
});

describe("ci serve applies fast-forwards only, and honours [skip ci] (#4122)", () => {
  test("a force push back to an older commit is recorded as seen and not applied, and the next fast-forward applies", async () => {
    const { root, app, main } = workspace();
    const later = commit(root, "app/later.txt");
    git(root, "push", "-q", "origin", "main");
    const forge = fakeForge(later);
    const { opts, events, state } = serve(app, forge);
    await ciServePass(opts);
    expect(ofType(events, "baseline")).toEqual([{ type: "baseline", commit: later }]);

    git(root, "reset", "-q", "--hard", main);
    git(root, "push", "-q", "-f", "origin", "main");
    forge.head = main;
    const back = await ciServePass(opts);
    expect(back.jobs).toEqual([]);
    expect(ofType(events, "not-run")).toEqual([{ type: "not-run", job: "apply", commit: main, reason: "not-fast-forward", branch: "main", from: later }]);
    expect(formatCiServeEvent(ofType(events, "not-run")[0]!)).toContain("not a fast-forward");
    const file = join(state, `${prApplyGroup("prod", "app")}.json`);
    expect(readCiServeState(file, { forge: "forgejo", repo: "demo/estate", env: "prod", branch: "main" }).target).toBe(main);

    const next = commit(root, "app/next.txt");
    git(root, "push", "-q", "origin", "main");
    forge.head = next;
    const pass = await ciServePass(opts);
    expect(pass.jobs).toEqual([expect.objectContaining({ job: "apply", commit: next, base: main, status: "ok" })]);
  });

  test("a target head whose message says [skip ci] is recorded as seen and not applied", async () => {
    const { root, app, main } = workspace();
    const forge = fakeForge(main);
    const { opts, events, state } = serve(app, forge);
    await ciServePass(opts);
    const skip = commit(root, "app/tidy.txt", "tidy the app [skip ci]");
    git(root, "push", "-q", "origin", "main");
    forge.head = skip;

    expect((await ciServePass(opts)).jobs).toEqual([]);
    expect(ofType(events, "not-run")).toEqual([{ type: "not-run", job: "apply", commit: skip, reason: "skip-ci" }]);
    expect(formatCiServeEvent(ofType(events, "not-run")[0]!)).toContain("says [skip ci]");
    const file = join(state, `${prApplyGroup("prod", "app")}.json`);
    expect(readCiServeState(file, { forge: "forgejo", repo: "demo/estate", env: "prod", branch: "main" }).target).toBe(skip);
  });

  test("a pull request head whose message says [ci skip] is not planned", async () => {
    const { root, app, main } = workspace();
    git(root, "checkout", "-q", "-b", "pr-4");
    const head = commit(root, "app/pr-4.txt", "draft [ci skip]");
    git(root, "push", "-q", "origin", `${head}:refs/pull/4/head`);
    git(root, "checkout", "-q", "main");
    const forge = fakeForge(main);
    forge.prs = [pr(4, head, main)];
    const { opts, events, state } = serve(app, forge);

    expect((await ciServePass(opts)).jobs).toEqual([]);
    expect(ofType(events, "not-run")).toEqual([{ type: "not-run", job: "plan", commit: head, pr: 4, reason: "skip-ci" }]);
    const file = join(state, `${prApplyGroup("prod", "app")}.json`);
    expect(readCiServeState(file, { forge: "forgejo", repo: "demo/estate", env: "prod", branch: "main" }).skipped).toEqual({ [ciServeKey({ job: "plan", pr: 4, commit: head })]: "skip-ci" });
    // Seen once: the next poll says nothing of it.
    expect((await ciServePass(opts)).jobs).toEqual([]);
    expect(ofType(events, "not-run")).toHaveLength(1);
  });
});
