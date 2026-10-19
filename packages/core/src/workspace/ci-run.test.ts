/**
 * #4094: `chant ci run plan|apply` runs one pull-request job as a pipeline
 * Op in a fresh worktree with a clean environment, records it as `pr-plan`
 * or `pr-apply` on `chant/lifecycle` signed by a runner key, and `ci tick
 * --source runs` then tags the commit.
 *
 * Every test works in its own temp repository with a bare origin, and the
 * runner key is a throwaway one. The job's `chant` is a stub script outside
 * the repository that records the arguments, environment and directory it
 * was run with. Nothing is written in process.cwd().
 */

import { execFileSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, declaration, git, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import { checkRunEventLines } from "./__fixtures__/run-event-check";
import { ciJobCommand, ciJobEnv, ciJobOp, ciRun, CiRunError, formatCiRun } from "./ci-run";
import { ciTick } from "./ci-green";
import { sshFromEd25519 } from "./trust/dsse";
import { verifyOpRunStatement } from "./trust/op-run-statement";
import { readRunLedger } from "../lifecycle/run-ledger";
import { prLoopJobs, PR_LOOP_SETUP } from "../components/pr-pipeline";
import { parseArgs } from "../cli/parse-args";

afterAll(cleanScratch);

const NOW = new Date("2026-10-18T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

function runnerKey(): { pem: string; ssh: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as { x: string };
  return { pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), ssh: sshFromEd25519(Buffer.from(jwk.x, "base64url")) };
}

const BOT = runnerKey();
const RUNNERS = [{ principal: "chant-runner", class: "runner" as const, key: BOT.ssh }];
const GREEN = { branch: "main", phases: { plan: ["pr-plan"], apply: ["pr-apply"] }, require: ["plan", "apply"], source: "runs" };

function commitAt(root: string, hours: number, file: string): string {
  writeFiles(root, { [file]: `${file} ${hours}\n` });
  const date = hoursAgo(hours);
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  for (const args of [["add", "-A"], ["commit", "-q", "-m", file]]) {
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, env, stdio: "ignore" });
  }
  return git(root, "rev-parse", "HEAD");
}

/** A checkout on main with a bare origin: member `app`, `ci.green` from runs, and BOT as the runner `chant-runner`. */
function workspace(): { root: string; app: string } {
  const origin = scratchDir("chant-ci-run-origin-");
  git(origin, "init", "-q", "--bare");
  const root = scratchDir("chant-ci-run-");
  git(root, "init", "-q");
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  git(root, "config", "user.name", "t");
  git(root, "config", "user.email", "t@example.com");
  writeFiles(root, {
    "chant.workspace.json": declaration([{ name: "app", dir: "app", kind: "other", because: "the app" }], { ci: { green: GREEN } }),
    ".chant/trust.json": JSON.stringify({ schema: 1, runners: [{ principal: "chant-runner", class: "runner", key: BOT.ssh }], roles: { runner: ["chant-runner"] } }),
    ".gitignore": ".chant/pr/\n",
    "app/a.txt": "a\n",
  });
  git(root, "remote", "add", "origin", origin);
  commitAt(root, 23, "app/init.txt");
  return { root, app: join(root, "app") };
}

/**
 * A stand-in for `chant` outside the repository. It keeps the arguments,
 * the environment and the directory it ran in as files under `.chant/pr`,
 * where the real commands write their reports, and exits `$FAKE_EXIT`.
 */
function fakeChant(): string {
  const file = join(scratchDir("chant-ci-run-bin-"), "chant");
  writeFileSync(
    file,
    [
      "#!/bin/sh",
      'stage="$2"',
      "mkdir -p .chant/pr",
      'echo "chant $1${2:+ $2}" >> .chant/pr/order',
      'printf "%s\\n" "$@" > ".chant/pr/$stage.args"',
      'env | sort > ".chant/pr/$stage.env"',
      'pwd -P > ".chant/pr/$stage.pwd"',
      'echo "{\\"stage\\": \\"$stage\\"}" > ".chant/pr/$stage.json"',
      'echo "fake $stage ran"',
      'exit "${FAKE_EXIT:-0}"',
      "",
    ].join("\n"),
  );
  chmodSync(file, 0o755);
  return file;
}

const HOST = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  GITHUB_TOKEN: "forge-token",
  GITHUB_REPOSITORY: "acme/estate",
  GITHUB_SERVER_URL: "http://forgejo.localhost",
  GITHUB_API_URL: "http://forgejo.localhost/api/v1",
  AWS_ACCESS_KEY_ID: "floci",
  NOT_FOR_JOBS: "leak",
  CHANT_RUNNER_KEY: BOT.pem,
  GITHUB_RUN_ID: "999",
};

const envFile = (dir: string, stage: string): Record<string, string> =>
  Object.fromEntries(
    readFileSync(join(dir, `${stage}.env`), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );

describe("the job as an Op (#4094)", () => {
  test("the job's variables come from flags, literals and the runner's tokens, and nothing else of the runner's", () => {
    const [plan, apply] = prLoopJobs("forgejo", "prod", { events: true });
    const env = ciJobEnv(plan!, { forge: "forgejo", env: "prod", values: { base: "b".repeat(40), pr: 7, commit: "c".repeat(40) }, hostEnv: HOST, passEnv: ["AWS_ACCESS_KEY_ID"] });
    expect(env).toMatchObject({
      BASE_SHA: "b".repeat(40),
      PR_NUMBER: "7",
      GITHUB_TOKEN: "forge-token",
      GITHUB_REPOSITORY: "acme/estate",
      GITHUB_SHA: "c".repeat(40),
      CHANT_ENV: "prod",
      CHANT_RUN_EVENTS_DIR: ".chant/pr/run-events",
      AWS_ACCESS_KEY_ID: "floci",
    });
    for (const name of ["NOT_FOR_JOBS", "CHANT_RUNNER_KEY", "GITHUB_RUN_ID"]) expect(env).not.toHaveProperty(name);
    // No `${{ ... }}` expression reaches a job.
    expect(Object.values(env).some((v) => v.includes("${{"))).toBe(false);

    expect(() => ciJobEnv(plan!, { forge: "forgejo", env: "prod", values: { base: "b".repeat(40), commit: "c".repeat(40) }, hostEnv: {} })).toThrow(CiRunError);
    expect(() => ciJobEnv(apply!, { forge: "forgejo", env: "prod", values: { commit: "c".repeat(40) }, hostEnv: {} })).toThrow(/pass --base <sha>/);

    const [, gitlabApply] = prLoopJobs("gitlab", "prod");
    const gl = ciJobEnv(gitlabApply!, { forge: "gitlab", env: "prod", values: { base: "b".repeat(40), commit: "c".repeat(40) }, hostEnv: {} });
    expect(gl).toEqual({ BASE_SHA: "b".repeat(40), CHANT_ENV: "prod", CI_COMMIT_SHA: "c".repeat(40) });
  });

  test("the Op runs the generated job's command, after its setup and build lines, each a clean shell step", () => {
    const [plan] = prLoopJobs("github", "prod", {}, "app");
    const op = ciJobOp({ job: plan!, env: "prod", cwd: "/w/app", jobEnv: { BASE_SHA: "b" }, setup: PR_LOOP_SETUP, build: ["npm ci"], chant: "npx chant" });
    expect(op.name).toBe("pr-plan");
    expect(op.labels).toMatchObject({ Env: "prod" });
    expect(op.phases.map((p) => [p.name, p.steps.length])).toEqual([["setup", 1], ["build", 1], ["plan", 1]]);
    const last = op.phases[2]!.steps[0] as { fn: string; args: Record<string, unknown> };
    expect(last.fn).toBe("shellCmd");
    expect(last.args).toEqual({ cmd: `npx chant${plan!.command.slice("chant".length)}`, cwd: "/w/app", env: { BASE_SHA: "b" }, inheritEnv: false });
    expect(plan!.command).toContain("--member app");

    // No setup or build lines: the job's phase alone. GitLab's apply keeps its base fallback in the command's shell.
    const [, gitlabApply] = prLoopJobs("gitlab", "prod");
    const bare = ciJobOp({ job: gitlabApply!, env: "prod", cwd: "/w", jobEnv: {}, setup: [], build: [] });
    expect(bare.phases.map((p) => p.name)).toEqual(["apply"]);
    expect(ciJobCommand(gitlabApply!)).toBe(`${gitlabApply!.setup![0]}\n${gitlabApply!.command}`);

    // #4088's build and lint lines follow --before-script, with chant replaced in each.
    const [built] = prLoopJobs("forgejo", "prod", { build: true });
    expect(built!.build).toEqual(["chant build --env prod", "chant lint"]);
    const withBuild = ciJobOp({ job: built!, env: "prod", cwd: "/w", jobEnv: {}, setup: [], build: ["npm ci", ...built!.build!], chant: "npx chant" });
    expect(withBuild.phases[0]!.steps.map((st) => ((st as unknown as { args: { cmd: string } }).args.cmd))).toEqual(["npm ci", "npx chant build --env prod", "npx chant lint"]);
  });

  test("the command line takes the job and the forge's values as flags", () => {
    const args = parseArgs(["ci", "run", "apply", "--env", "prod", "--base", "abc", "--commit", "def", "--pass-env", "AWS_PROFILE", "--pass-env", "AWS_REGION", "--chant", "npx chant", "--key", "k.pem", "--pr-build", "--pr-build-command", "npm run build"]);
    expect(args).toMatchObject({ prBuild: true, prBuildCommand: "npm run build" });
    expect(args).toMatchObject({ command: "ci", path: "run", extraPositional: "apply", env: "prod", base: "abc", commit: "def", passEnv: ["AWS_PROFILE", "AWS_REGION"], ciChant: "npx chant", key: "k.pem" });
    expect(() => parseArgs(["ci", "run", "plan", "--commit"])).toThrow(/--commit needs/);
  });
});

describe("chant ci run, then ci tick from runs (#4094)", () => {
  test("plan and apply run in a fresh worktree, are recorded signed, and the tick tags the commit green", async () => {
    const before = { worktrees: undefined as string | undefined };
    const { root, app } = workspace();
    const base = git(root, "rev-parse", "HEAD");
    const sha = commitAt(root, 2, "app/a.txt");
    git(root, "push", "-q", "origin", "main");
    before.worktrees = git(root, "worktree", "list", "--porcelain");
    const chant = fakeChant();
    const reports = scratchDir("chant-ci-run-reports-");

    const events: string[] = [];
    const plan = await ciRun({
      cwd: app,
      job: "plan",
      env: "prod",
      forge: "forgejo",
      base,
      pr: 7,
      chant,
      hostEnv: HOST,
      passEnv: ["AWS_ACCESS_KEY_ID"],
      runnerKey: BOT.pem,
      output: join(reports, "plan"),
      runId: "chant-plan-1",
      runEvents: (line) => events.push(line),
    });
    expect(plan.status).toBe("ok");
    expect(plan.warnings).toEqual([]);
    expect(plan.signer).toBe("chant-runner");
    expect(plan.pushed).toBe(true);

    // The job ran the generated command, in the member's directory of a checkout outside the repository.
    const out = join(reports, "plan");
    const [job] = prLoopJobs("forgejo", "prod", {}, "app");
    const argv = readFileSync(join(out, "pr-plan.args"), "utf-8").trimEnd().split("\n");
    expect(argv).toEqual(["components", "pr-plan", "--base", base, "--pr", "7", "--env", "prod", "--gate", "pr-apply", "--output", ".chant/pr", "--forge", "forgejo", "--member", "app"]);
    expect(job!.command.split(" ").slice(1).map((a) => a.replace(/"/g, ""))).toEqual(argv.map((a) => (a === base ? "$BASE_SHA" : a === "7" ? "$PR_NUMBER" : a)));
    const pwd = readFileSync(join(out, "pr-plan.pwd"), "utf-8").trim();
    expect(pwd).toBe(join(plan.checkout, "app"));
    expect(pwd.startsWith(realpathSync(root))).toBe(false);
    expect(existsSync(plan.checkout)).toBe(false);
    expect(git(root, "worktree", "list", "--porcelain")).toBe(before.worktrees);
    expect(JSON.parse(readFileSync(join(out, "pr-plan.json"), "utf-8"))).toEqual({ stage: "pr-plan" });

    // The environment is clean: the job's variables and the few the runner hands on.
    const env = envFile(out, "pr-plan");
    expect(env).toMatchObject({ BASE_SHA: base, PR_NUMBER: "7", GITHUB_SHA: sha, CHANT_ENV: "prod", GITHUB_TOKEN: "forge-token", AWS_ACCESS_KEY_ID: "floci" });
    for (const name of ["NOT_FOR_JOBS", "CHANT_RUNNER_KEY", "GITHUB_RUN_ID"]) expect(env).not.toHaveProperty(name);

    // The record: Op pr-plan at the commit, run by chant, with a statement that verifies.
    expect(plan.record).toMatchObject({ op: "pr-plan", env: "prod", status: "ok", gitSha: sha, runOrigin: { forge: "chant" }, id: "chant-plan-1" });
    const stored = (await readRunLedger("prod", "pr-plan", { cwd: app })).records.at(-1)!;
    expect(stored.statement).toEqual(plan.record.statement);
    expect(verifyOpRunStatement(stored, RUNNERS, { runner: ["chant-runner"] })).toMatchObject({ status: "signed", signer: "chant-runner" });
    expect(stored.phases.map((p) => [p.name, p.status])).toEqual([["setup", "ok"], ["plan", "ok"]]);

    // The events: a pipeline run, on the chant runner.
    const stream = checkRunEventLines(events);
    expect(stream[0]).toMatchObject({ kind: "pipeline", runtime: "ci", name: "pr-plan", runId: "chant-plan-1", gitSha: sha, runOrigin: { forge: "chant" } });
    expect(stream.at(-1)).toMatchObject({ type: "run-settle", status: "ok" });

    const apply = await ciRun({ cwd: app, job: "apply", env: "prod", forge: "forgejo", base, chant, hostEnv: HOST, runnerKey: BOT.pem, output: join(reports, "apply") });
    expect(apply.status).toBe("ok");
    const applyArgs = readFileSync(join(reports, "apply", "pr-apply.args"), "utf-8").trimEnd().split("\n");
    expect(applyArgs).toEqual(["components", "pr-apply", "--base", base, "--env", "prod", "--gate", "pr-apply", "--output", ".chant/pr", "--forge", "forgejo", "--member", "app", "--require-review", "--resume", ".chant/pr-resume/pr-apply.json"]);
    expect(formatCiRun(apply)).toContain("signed by chant-runner");

    // The records reached origin, and a tick from runs tags the commit green with no forge.
    expect(git(root, "ls-remote", "origin", "chant/lifecycle")).toContain(git(root, "rev-parse", "chant/lifecycle"));
    const tick = await ciTick({ cwd: app, now: NOW, runnerKey: BOT.pem });
    expect(tick.source).toBe("runs");
    expect(tick.made).toEqual([`ci/green/${sha}`]);
    const note = git(root, "tag", "-l", "--format=%(contents)", `ci/green/${sha}`);
    const record = JSON.parse(note.slice(note.indexOf("{"))) as { phases: Record<string, { name: string; opRun: { id: string; signer: string } }[]> };
    expect(record.phases.plan![0]).toMatchObject({ name: "pr-plan", opRun: { id: "chant-plan-1", signer: "chant-runner" } });
    expect(record.phases.apply![0]).toMatchObject({ name: "pr-apply", opRun: { id: apply.record.id, signer: "chant-runner" } });
  });

  test("a failing job is recorded failed, and a key from the environment that trust.json does not list leaves it unsigned", async () => {
    const { root, app } = workspace();
    const base = git(root, "rev-parse", "HEAD");
    commitAt(root, 2, "app/a.txt");
    const stranger = runnerKey();
    const lines: string[] = [];
    const r = await ciRun({
      cwd: app,
      job: "apply",
      env: "prod",
      forge: "github",
      base,
      chant: fakeChant(),
      hostEnv: { ...HOST, FAKE_EXIT: "3" },
      passEnv: ["FAKE_EXIT"],
      runnerKey: stranger.pem,
      runnerKeyFromEnv: true,
      output: join(scratchDir("chant-ci-run-out-"), "pr"),
      push: false,
      stepOutput: (line) => lines.push(line),
    });
    expect(r.status).toBe("fail");
    expect(r.record.status).toBe("fail");
    expect(r.record.statement).toBeUndefined();
    expect(r.signer).toBeNull();
    expect(r.warnings[0]).toMatch(/CHANT_RUNNER_KEY is set, and the run will not be signed: .*lists no runner with this key/);
    expect(r.failure).toMatchObject({ phase: "apply", error: expect.stringContaining("command exited 3") });
    expect(lines.some((l) => l.includes("fake pr-apply ran"))).toBe(true);
    expect(r.report).not.toBeNull();
    expect(formatCiRun(r)).toContain("unsigned, so ci tick from runs does not count it");

    // The same key given with --key refuses the run before anything runs.
    await expect(ciRun({ cwd: app, job: "apply", env: "prod", forge: "github", base, chant: fakeChant(), hostEnv: HOST, runnerKey: stranger.pem, push: false })).rejects.toThrow(/would not be signed/);
    expect((await readRunLedger("prod", "pr-apply", { cwd: app })).records).toHaveLength(1);
  });

  test("--pr-build runs the job's build and lint lines after --before-script and before the command, and a failing build fails the job", async () => {
    const { root, app } = workspace();
    const base = git(root, "rev-parse", "HEAD");
    const sha = commitAt(root, 2, "app/a.txt");
    const chant = fakeChant();
    const out = join(scratchDir("chant-ci-run-build-"), "pr");
    const ok = await ciRun({
      cwd: app,
      job: "plan",
      env: "prod",
      forge: "forgejo",
      base,
      pr: 3,
      chant,
      hostEnv: HOST,
      beforeScript: ["mkdir -p .chant/pr && echo before-script >> .chant/pr/order"],
      loop: { buildCommand: "echo build >> .chant/pr/order" },
      push: false,
      output: out,
    });
    expect(ok.status).toBe("ok");
    expect(readFileSync(join(out, "order"), "utf-8").trimEnd().split("\n")).toEqual(["before-script", "build", "chant lint", "chant components pr-plan"]);
    expect(ok.record.phases.map((p) => [p.name, p.status, p.steps.length])).toEqual([["setup", "ok", 1], ["build", "ok", 3], ["plan", "ok", 1]]);

    const failed = await ciRun({
      cwd: app,
      job: "apply",
      env: "prod",
      forge: "forgejo",
      base,
      chant,
      hostEnv: HOST,
      loop: { buildCommand: "mkdir -p .chant/pr && echo build >> .chant/pr/order && exit 4" },
      runnerKey: BOT.pem,
      push: false,
      output: join(scratchDir("chant-ci-run-build-"), "pr"),
    });
    expect(failed.status).toBe("fail");
    expect(failed.failure).toMatchObject({ phase: "build", error: expect.stringContaining("command exited 4") });
    expect(failed.record).toMatchObject({ op: "pr-apply", status: "fail", gitSha: sha, runOrigin: { forge: "chant" } });
    expect(failed.record.phases.map((p) => [p.name, p.status])).toEqual([["setup", "ok"], ["build", "fail"]]);
    // The command never ran: the report holds the build's line alone.
    expect(readFileSync(join(failed.report!, "order"), "utf-8").trimEnd().split("\n")).toEqual(["build"]);
    const stored = (await readRunLedger("prod", "pr-apply", { cwd: app })).records.at(-1)!;
    expect(stored.status).toBe("fail");
    expect(verifyOpRunStatement(stored, RUNNERS, { runner: ["chant-runner"] })).toMatchObject({ status: "signed" });
  });
});
