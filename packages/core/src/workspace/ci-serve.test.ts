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
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, declaration, git, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import { ciServeInterval, ciServeKey, ciServePass, formatCiServeEvent, readCiServeState, type CiServeEvent, type CiServeForge, type CiServeOptions } from "./ci-serve";
import { acquireLease, releaseLease } from "../lifecycle/lease";
import { prApplyGroup, prApplyRecordKey } from "../components/pr-pipeline";
import { parseArgs } from "../cli/parse-args";
import type { OpenPullRequest } from "../pr-forge";

afterAll(cleanScratch);

function commit(root: string, file: string): string {
  writeFiles(root, { [file]: `${file} ${Math.random()}\n` });
  for (const args of [["add", "-A"], ["commit", "-q", "-m", file]]) {
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "ignore" });
  }
  return git(root, "rev-parse", "HEAD");
}

/** A clone on main with a bare origin and member `app`. */
function workspace(): { root: string; app: string; main: string } {
  const origin = scratchDir("chant-ci-serve-origin-");
  git(origin, "init", "-q", "--bare");
  const root = scratchDir("chant-ci-serve-");
  git(root, "init", "-q");
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  writeFiles(root, {
    "chant.workspace.json": declaration([{ name: "app", dir: "app", kind: "other", because: "the app" }]),
    ".gitignore": ".chant/pr/\n.chant/pr-resume/\n",
    "app/a.txt": "a\n",
  });
  git(root, "remote", "add", "origin", origin);
  const main = commit(root, "app/init.txt");
  git(root, "push", "-q", "origin", "main");
  return { root, app: join(root, "app"), main };
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
function fakeForge(head: string): CiServeForge & { head: string; prs: OpenPullRequest[]; polls: number } {
  const f = {
    head,
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
      // A job image of its own, so no setup line downloads OpenTofu.
      job: { image: "chant-ci-serve-test:local", chant: fakeChant(), hostEnv: env, passEnv: Object.keys(hostEnv ?? {}) },
      log: (e) => events.push(e),
      ...rest,
    },
  };
}

const argsOf = (report: string, stage: string): string[] => readFileSync(join(report, `${stage}.args`), "utf-8").trimEnd().split("\n");
const ofType = <T extends CiServeEvent["type"]>(events: CiServeEvent[], type: T) => events.filter((e): e is Extract<CiServeEvent, { type: T }> => e.type === type);

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

  test("a failed apply stays failed, and --rerun-failed runs it again with its resume record", async () => {
    const { root, app, main } = workspace();
    const forge = fakeForge(main);
    const failing = serve(app, forge, { hostEnv: { FAKE_EXIT: "3", FAKE_ATTEMPT: "1" } });
    await ciServePass(failing.opts);
    const merged = commit(root, "app/merged.txt");
    git(root, "push", "-q", "origin", "main");
    forge.head = merged;

    const failed = await ciServePass(failing.opts);
    expect(failed.jobs).toEqual([expect.objectContaining({ job: "apply", status: "fail", attempts: 1, failure: expect.stringContaining("command-failed") })]);
    const record = join(failing.state, "resume", `${prApplyRecordKey("prod", merged, "app")}.json`);
    expect(JSON.parse(readFileSync(record, "utf-8"))).toEqual({ attempt: "1" });
    expect(existsSync(join(failed.jobs[0]!.report!, "resume-in.json"))).toBe(false);

    // Without --rerun-failed the failed apply is not run again.
    expect((await ciServePass(failing.opts)).jobs).toEqual([]);

    const retry = serve(app, forge, { stateDir: failing.state, rerunFailed: true, hostEnv: { FAKE_EXIT: "0", FAKE_ATTEMPT: "2" } });
    const again = await ciServePass(retry.opts);
    expect(again.jobs).toEqual([expect.objectContaining({ job: "apply", commit: merged, base: main, status: "ok", attempts: 2 })]);
    expect(ofType(retry.events, "started")[0]).toMatchObject({ attempt: 2, resume: record });
    // The job read the first attempt's record, and left its own.
    expect(JSON.parse(readFileSync(join(again.jobs[0]!.report!, "resume-in.json"), "utf-8"))).toEqual({ attempt: "1" });
    expect(JSON.parse(readFileSync(record, "utf-8"))).toEqual({ attempt: "2" });
    // A passed apply is not run again, --rerun-failed or not.
    expect((await ciServePass(retry.opts)).jobs).toEqual([]);
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
