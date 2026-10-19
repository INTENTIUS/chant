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
import { chmodSync, existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, declaration, git, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import { checkRunEventLines } from "./__fixtures__/run-event-check";
import { ciJobCommand, ciJobEnv, ciJobFailure, ciJobOp, ciRun, CiRunError, ciStatusContext, ciStatusFromEnv, ciStatusUrl, formatCiRun } from "./ci-run";
import type { CommitStatus } from "../pr-forge";
import { ciTick, evaluateCommit, readOpRunSource, revokedAnnotation } from "./ci-green";
import type { StepRecord } from "../op/local-executor";
import { sshFromEd25519 } from "./trust/dsse";
import { verifyOpRunStatement } from "./trust/op-run-statement";
import { readRunLedger } from "../lifecycle/run-ledger";
import { prLoopJobs, PR_LOOP_SETUP } from "../components/pr-pipeline";
import { parseArgs } from "../cli/parse-args";
import { ciSecretsFor, readCiSecrets } from "./ci-secrets";
import { runEventFileName, runEventsDir } from "../run-event-store";

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
      // FAKE_REPORT, when the job is given it, is the pr report the command writes.
      'if [ -n "$FAKE_REPORT" ]; then printf "%s" "$FAKE_REPORT" > ".chant/pr/$stage.json"; else echo "{\\"stage\\": \\"$stage\\"}" > ".chant/pr/$stage.json"; fi',
      'echo "fake $stage ran"',
      'exit "${FAKE_EXIT:-0}"',
      "",
    ].join("\n"),
  );
  chmodSync(file, 0o755);
  return file;
}

// A job image of its own, so the jobs get no setup lines: the default image's
// OpenTofu install would download from the network on a runner without tofu.
const JOB_IMAGE = "chant-ci-run-test:local";

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
    const plan = await ciRun({ image: JOB_IMAGE,
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

    // The environment is clean: the job's variables and the few the runner hands on. The copied
    // report shows the values of the variables whose names look secret as *** (#4096).
    const env = envFile(out, "pr-plan");
    expect(env).toMatchObject({ BASE_SHA: base, PR_NUMBER: "7", GITHUB_SHA: sha, CHANT_ENV: "prod", GITHUB_TOKEN: "***", AWS_ACCESS_KEY_ID: "***" });
    for (const name of ["NOT_FOR_JOBS", "CHANT_RUNNER_KEY", "GITHUB_RUN_ID"]) expect(env).not.toHaveProperty(name);

    // The record: Op pr-plan at the commit, run by chant, with a statement that verifies.
    expect(plan.record).toMatchObject({ op: "pr-plan", env: "prod", status: "ok", gitSha: sha, runOrigin: { forge: "chant" }, id: "chant-plan-1" });
    const stored = (await readRunLedger("prod", "pr-plan", { cwd: app })).records.at(-1)!;
    expect(stored.statement).toEqual(plan.record.statement);
    expect(verifyOpRunStatement(stored, RUNNERS, { runner: ["chant-runner"] })).toMatchObject({ status: "signed", signer: "chant-runner" });
    expect(stored.phases.map((p) => [p.name, p.status])).toEqual([["plan", "ok"]]);

    // The events: a pipeline run, on the chant runner.
    const stream = checkRunEventLines(events);
    expect(stream[0]).toMatchObject({ kind: "pipeline", runtime: "ci", name: "pr-plan", runId: "chant-plan-1", gitSha: sha, runOrigin: { forge: "chant" } });
    expect(stream.at(-1)).toMatchObject({ type: "run-settle", status: "ok" });

    const apply = await ciRun({ image: JOB_IMAGE, cwd: app, job: "apply", env: "prod", forge: "forgejo", base, chant, hostEnv: HOST, runnerKey: BOT.pem, output: join(reports, "apply") });
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
    const r = await ciRun({ image: JOB_IMAGE,
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
    // The report says nothing about a failure, so the record names the command.
    expect(r.record.failure).toMatchObject({ code: "command-failed", phase: "apply", exitCode: 3, reason: expect.stringContaining("command exited 3") });
    expect(lines.some((l) => l.includes("fake pr-apply ran"))).toBe(true);
    expect(r.report).not.toBeNull();
    expect(formatCiRun(r)).toContain("unsigned, so ci tick from runs does not count it");

    // The same key given with --key refuses the run before anything runs.
    await expect(ciRun({ image: JOB_IMAGE, cwd: app, job: "apply", env: "prod", forge: "github", base, chant: fakeChant(), hostEnv: HOST, runnerKey: stranger.pem, push: false })).rejects.toThrow(/would not be signed/);
    expect((await readRunLedger("prod", "pr-apply", { cwd: app })).records).toHaveLength(1);
  });

  test("--pr-build runs the job's build and lint lines after --before-script and before the command, and a failing build fails the job", async () => {
    const { root, app } = workspace();
    const base = git(root, "rev-parse", "HEAD");
    const sha = commitAt(root, 2, "app/a.txt");
    const chant = fakeChant();
    const out = join(scratchDir("chant-ci-run-build-"), "pr");
    const ok = await ciRun({ image: JOB_IMAGE,
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
    expect(ok.record.phases.map((p) => [p.name, p.status, p.steps.length])).toEqual([["build", "ok", 3], ["plan", "ok", 1]]);

    const failed = await ciRun({ image: JOB_IMAGE,
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
    expect(failed.record.phases.map((p) => [p.name, p.status])).toEqual([["build", "fail"]]);
    // The command never ran: the report holds the build's line alone.
    expect(readFileSync(join(failed.report!, "order"), "utf-8").trimEnd().split("\n")).toEqual(["build"]);
    const stored = (await readRunLedger("prod", "pr-apply", { cwd: app })).records.at(-1)!;
    expect(stored.status).toBe("fail");
    expect(stored.failure).toEqual({ code: "build-failed", phase: "build", exitCode: 4, reason: "mkdir -p .chant/pr && echo build >> .chant/pr/order && exit 4 exited 4" });
    expect(verifyOpRunStatement(stored, RUNNERS, { runner: ["chant-runner"] })).toMatchObject({ status: "signed" });
  });

  test("a failed job's record and settle event say why from its pr report, signed, and a revoke note names the code", async () => {
    const { root, app } = workspace();
    const base = git(root, "rev-parse", "HEAD");
    const sha = commitAt(root, 2, "app/a.txt");
    const refusedReport = { stage: "apply", status: "refused", refusal: "not-a-reviewer", message: "ana approved the plan, and ana has not approved the pull request on the forge" };
    const extra = { FAKE_EXIT: "3", FAKE_REPORT: JSON.stringify(refusedReport) };
    const events: string[] = [];
    const refused = await ciRun({
      image: JOB_IMAGE,
      cwd: app,
      job: "apply",
      env: "prod",
      forge: "forgejo",
      base,
      chant: fakeChant(),
      hostEnv: { ...HOST, ...extra },
      passEnv: Object.keys(extra),
      runnerKey: BOT.pem,
      push: false,
      output: join(scratchDir("chant-ci-run-why-"), "pr"),
      runEvents: (line) => events.push(line),
    });
    expect(refused.status).toBe("fail");
    const why = { code: "not-a-reviewer", reason: refusedReport.message, phase: "apply", exitCode: 3 };
    expect(refused.record.failure).toEqual(why);
    expect(formatCiRun(refused)).toContain("failure: not-a-reviewer in apply, exit 3: ana approved the plan");
    const stored = (await readRunLedger("prod", "pr-apply", { cwd: app })).records.at(-1)!;
    expect(stored.failure).toEqual(why);
    // The failure is signed with the rest of the record.
    expect(verifyOpRunStatement(stored, RUNNERS, { runner: ["chant-runner"] })).toMatchObject({ status: "signed" });
    // The settle event carries it, and validates against run-event.schema.json.
    expect(checkRunEventLines(events).at(-1)).toMatchObject({ type: "run-settle", status: "failed", kind: "pipeline", failure: why });

    // A tick from runs reads the code, and the revoke note names it.
    const runs = (await readOpRunSource(app, root, git(root, "rev-parse", "HEAD"))).checkRuns(sha);
    expect(runs).toEqual([expect.objectContaining({ name: "pr-apply", conclusion: "failure", failureCode: "not-a-reviewer" })]);
    const green = { branch: "main", window: "7d", phases: [{ name: "apply", runs: ["pr-apply"] }], require: ["apply"], source: "runs" } as unknown as Parameters<typeof evaluateCommit>[0];
    const verdict = evaluateCommit(green, runs);
    expect(revokedAnnotation(green, sha, verdict.failure!, NOW).split("\n")[0]).toBe("ci: phase apply failed in pr-apply (failure, not-a-reviewer)");
  });

  test("the failure code comes from the report's refusal, its status and failed members, or the command", () => {
    const op = ciJobOp({ job: prLoopJobs("forgejo", "prod")[1]!, env: "prod", cwd: "/w", jobEnv: {}, setup: [], build: ["npm ci"] });
    const dir = scratchDir("chant-ci-run-report-");
    const fail = (phase: string, code: number) => ({ phase, fn: "shellCmd", status: "fail", durationMs: 1, error: `command exited ${code} (expected 0): Command failed: x\nnoise` }) as unknown as StepRecord;
    const ok = (phase: string) => ({ phase, fn: "shellCmd", status: "ok", durationMs: 1 }) as unknown as StepRecord;
    const at = (records: StepRecord[]) => ciJobFailure({ job: "apply", op, records, reportDir: dir });

    expect(at([ok("build"), ok("apply")])).toBeUndefined();
    expect(at([fail("build", 2)])).toEqual({ code: "build-failed", reason: "npm ci exited 2", phase: "build", exitCode: 2 });
    expect(at([ok("build"), fail("apply", 1)])).toEqual({ code: "command-failed", reason: "command exited 1 (expected 0): Command failed: x", phase: "apply", exitCode: 1 });

    writeFileSync(join(dir, "pr-apply.json"), JSON.stringify({ status: "failed", members: [
      { member: "network", status: "applied" },
      { member: "cluster-a", status: "failed", error: "stack CREATE_FAILED\nmore" },
      { member: "cluster-b", status: "failed" },
      { member: "app-01", status: "blocked" },
    ] }));
    expect(at([ok("build"), fail("apply", 1)])).toEqual({ code: "failed", reason: "members cluster-a failed (stack CREATE_FAILED), cluster-b failed", phase: "apply", exitCode: 1 });
    writeFileSync(join(dir, "pr-apply.json"), JSON.stringify({ status: "refused", refusal: "plan-changed", message: "the plan changed after review\nsecond line" }));
    expect(at([ok("build"), fail("apply", 3)])).toEqual({ code: "plan-changed", reason: "the plan changed after review", phase: "apply", exitCode: 3 });
    // A report that says the job did its work leaves the command's failure.
    writeFileSync(join(dir, "pr-apply.json"), JSON.stringify({ status: "applied", members: [] }));
    expect(at([ok("build"), fail("apply", 1)])!.code).toBe("command-failed");
  });
});

describe("a commit status per job (#4097)", () => {
  /** A fake forge client: it records each status, and fails on the states in `refuse`. */
  function fakeForge(refuse: string[] = []): { client: { setCommitStatus(sha: string, status: CommitStatus): Promise<void> }; posts: { sha: string; status: CommitStatus }[] } {
    const posts: { sha: string; status: CommitStatus }[] = [];
    return {
      posts,
      client: {
        async setCommitStatus(sha, status) {
          if (refuse.includes(status.state)) throw new Error(`POST /statuses/${sha} answered 500`);
          posts.push({ sha, status });
        },
      },
    };
  }

  async function job(over: Record<string, unknown>) {
    const { root, app } = workspace();
    const base = git(root, "rev-parse", "HEAD");
    const sha = commitAt(root, 2, "app/a.txt");
    const r = await ciRun({ image: JOB_IMAGE, cwd: app, job: "plan", env: "prod", forge: "forgejo", base, pr: 7, chant: fakeChant(), hostEnv: HOST, push: false, output: join(scratchDir("chant-ci-status-"), "pr"), ...over } as Parameters<typeof ciRun>[0]);
    return { r, sha };
  }

  test("a good job posts pending, then success, at its commit", async () => {
    const forge = fakeForge();
    const { r, sha } = await job({ status: { client: forge.client } });
    expect(r.status).toBe("ok");
    expect(r.warnings).toEqual([]);
    expect(forge.posts.map((p) => [p.sha, p.status.context, p.status.state])).toEqual([[sha, "chant/pr-plan", "pending"], [sha, "chant/pr-plan", "success"]]);
    expect(forge.posts[0]!.status.description).toBe("pr-plan running");
    expect(forge.posts[1]!.status.description).toMatch(/^pr-plan passed in \d+s$/);
    expect(forge.posts[1]!.status).not.toHaveProperty("targetUrl");
  });

  test("a failed job posts pending, then failure with the run record's code and reason", async () => {
    const forge = fakeForge();
    const report = JSON.stringify({ stage: "apply", status: "refused", refusal: "not-approved", message: "no reviewer approved this plan" });
    const { r } = await job({ job: "apply", pr: undefined, hostEnv: { ...HOST, FAKE_EXIT: "1", FAKE_REPORT: report }, passEnv: ["FAKE_EXIT", "FAKE_REPORT"], status: { client: forge.client } });
    expect(r.status).toBe("fail");
    expect(forge.posts.map((p) => [p.status.context, p.status.state])).toEqual([["chant/pr-apply", "pending"], ["chant/pr-apply", "failure"]]);
    expect(r.record.failure!.code).toBe("not-approved");
    expect(forge.posts[1]!.status.description).toBe("not-approved: no reviewer approved this plan");
  });

  test("a long failure reason is cut to the forge's 140 characters", async () => {
    const forge = fakeForge();
    const report = JSON.stringify({ stage: "apply", status: "refused", refusal: "plan-changed", message: "y".repeat(400) });
    await job({ job: "apply", pr: undefined, hostEnv: { ...HOST, FAKE_EXIT: "1", FAKE_REPORT: report }, passEnv: ["FAKE_EXIT", "FAKE_REPORT"], status: { client: forge.client } });
    const d = forge.posts[1]!.status.description;
    expect(d).toHaveLength(140);
    expect(d.startsWith("plan-changed: yyy")).toBe(true);
    expect(d.endsWith("...")).toBe(true);
  });

  test("a renamed gate names the apply's context", async () => {
    const forge = fakeForge();
    await job({ job: "apply", pr: undefined, loop: { gate: "prod-approval" }, status: { client: forge.client } });
    expect(forge.posts.map((p) => p.status.context)).toEqual(["chant/prod-approval", "chant/prod-approval"]);
    expect(ciStatusContext("plan", "prod-approval")).toBe("chant/pr-plan");
  });

  // One job per test: each runs a whole Op in a worktree, and three in one test went over the unit budget.
  test("target_url is an https --report-url with the key", async () => {
    const https = fakeForge();
    const { sha } = await job({ loop: { reportUrl: "https://host/reports/" }, status: { client: https.client } });
    const key = `7/${sha}/app`;
    expect(https.posts.map((p) => p.status.targetUrl)).toEqual([`https://host/reports/${key}/`, `https://host/reports/${key}/`]);
  });

  test("target_url is the --status-url template for an s3 --report-url", async () => {
    const s3 = fakeForge();
    const mapped = await job({ loop: { reportUrl: "s3://bucket/prefix" }, status: { client: s3.client, urlTemplate: "https://host/reports/{key}" } });
    expect(s3.posts.map((p) => p.status.targetUrl)).toEqual([`https://host/reports/7/${mapped.sha}/app`, `https://host/reports/7/${mapped.sha}/app`]);
  });

  test("an s3 or file --report-url with no --status-url gives no target_url", async () => {
    const bare = fakeForge();
    await job({ loop: { reportUrl: "s3://bucket/prefix" }, status: { client: bare.client } });
    expect(bare.posts.every((p) => p.status.targetUrl === undefined)).toBe(true);
    expect(ciStatusUrl({ reportUrl: "file:///tmp/r", commit: "abc" })).toBeUndefined();
  });

  test("--no-status, a missing token and GitLab give no client; a bad --status-url is refused", () => {
    const env = { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "acme/estate", GITHUB_SERVER_URL: "http://forgejo.localhost", GITHUB_API_URL: "http://forgejo.localhost/api/v1" };
    expect(ciStatusFromEnv({ forge: "forgejo", hostEnv: env, noStatus: true })).toEqual({});
    expect(ciStatusFromEnv({ forge: "forgejo", hostEnv: { GITHUB_REPOSITORY: "acme/estate" } })).toEqual({});
    expect(ciStatusFromEnv({ forge: "gitlab", hostEnv: { ...env, GITLAB_TOKEN: "t" } })).toEqual({});
    expect(ciStatusFromEnv({ forge: "forgejo", hostEnv: env }).status?.client.setCommitStatus).toBeTypeOf("function");
    expect(ciStatusFromEnv({ forge: "forgejo", hostEnv: env, statusUrl: "https://h/{key}" }).status?.urlTemplate).toBe("https://h/{key}");
    expect(ciStatusFromEnv({ forge: "forgejo", hostEnv: { GITHUB_TOKEN: "t" } }).warning).toMatch(/no commit status/);
    expect(() => ciStatusFromEnv({ forge: "forgejo", hostEnv: env, statusUrl: "s3://b/{key}" })).toThrow(/--status-url takes an http or https URL/);
    const flags = parseArgs(["ci", "run", "plan", "--no-status", "--status-url", "https://h/{key}"]);
    expect(flags).toMatchObject({ noStatus: true, statusUrl: "https://h/{key}" });
  });

  test("a status the forge refuses is a warning, and the job stays ok", async () => {
    const forge = fakeForge(["pending", "success"]);
    const { r } = await job({ status: { client: forge.client } });
    expect(r.status).toBe("ok");
    expect(r.record.status).toBe("ok");
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toMatch(/could not set the chant\/pr-plan status: POST \/statuses\/[0-9a-f]+ answered 500/);
  });
});

/** A secrets file only its owner can read, as `--secrets` takes it. */
function secretsFile(text: string, name = "secrets.env"): string {
  const file = join(scratchDir("chant-ci-run-secrets-"), name);
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

/** Every file under `dir`, with its text. */
function filesUnder(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out[path] = readFileSync(path, "utf-8");
  }
  return out;
}

describe("the job's secrets from the host (#4096)", () => {
  test("a secret reaches the step, and the file's allowlist keeps one from the plan", async () => {
    const { root, app } = workspace();
    const base = git(root, "rev-parse", "HEAD");
    commitAt(root, 2, "app/a.txt");
    const secrets = readCiSecrets(
      secretsFile(JSON.stringify({ secrets: { DB_PASSWORD: "hunter22-db", DEPLOY_KEY: "deploy-key-value" }, jobs: { plan: ["DB_PASSWORD"] } }), "secrets.json"),
    );
    const out = join(scratchDir("chant-ci-run-secret-"), "pr");
    const r = await ciRun({
      image: JOB_IMAGE,
      cwd: app,
      job: "plan",
      env: "prod",
      forge: "forgejo",
      base,
      pr: 5,
      chant: fakeChant(),
      hostEnv: HOST,
      secrets,
      // The step checks the value it got, and that the plan got no DEPLOY_KEY.
      beforeScript: ['test "$DB_PASSWORD" = "hunter22-db" && test -z "${DEPLOY_KEY+set}" && mkdir -p .chant/pr && echo reached > .chant/pr/reached'],
      push: false,
      output: out,
    });
    expect(r.status).toBe("ok");
    expect(readFileSync(join(out, "reached"), "utf-8").trim()).toBe("reached");
    const env = envFile(out, "pr-plan");
    // The value reached the command too, and the copied report shows it as ***.
    expect(env.DB_PASSWORD).toBe("***");
    expect(env).not.toHaveProperty("DEPLOY_KEY");
    expect(env).not.toHaveProperty("CHANT_RUNNER_KEY");

    // The apply is not in the allowlist, so it gets every secret.
    const [, apply] = prLoopJobs("forgejo", "prod");
    const applyEnv = ciJobEnv(apply!, { forge: "forgejo", env: "prod", values: { base, commit: base }, hostEnv: HOST, secrets: ciSecretsFor(secrets, "apply") });
    expect(applyEnv).toMatchObject({ DB_PASSWORD: "hunter22-db", DEPLOY_KEY: "deploy-key-value" });
    // A secret can replace a forge token, and never the variables the runner sets.
    const over = ciJobEnv(apply!, { forge: "forgejo", env: "prod", values: { base, commit: base }, hostEnv: HOST, secrets: { GITHUB_TOKEN: "from-file", BASE_SHA: "x", CHANT_RUNNER_KEY: "k" } });
    expect(over).toMatchObject({ GITHUB_TOKEN: "from-file", BASE_SHA: base });
    expect(over).not.toHaveProperty("CHANT_RUNNER_KEY");
    expect(() => ciJobEnv(apply!, { forge: "forgejo", env: "prod", values: { base, commit: base }, hostEnv: HOST, passEnv: ["CHANT_RUNNER_KEY"] })).toThrow(/never passed to a job/);
  });

  test("a secret the job prints, writes in its report or fails with is *** in the events, the signed record, the copied report and the output", async () => {
    const { root, app } = workspace();
    const base = git(root, "rev-parse", "HEAD");
    commitAt(root, 2, "app/a.txt");
    const SECRET = "s3cret pass#1";
    const TOKEN = "tok-abc123";
    const secrets = readCiSecrets(secretsFile(`# the host's secrets\nDB_PASSWORD="${SECRET}"\nexport PIN=abc\n`));
    expect(secrets.values).toEqual({ DB_PASSWORD: SECRET, PIN: "abc" });

    const leaky = join(scratchDir("chant-ci-run-bin-"), "chant");
    writeFileSync(
      leaky,
      [
        "#!/bin/sh",
        "mkdir -p .chant/pr",
        'env | sort > .chant/pr/pr-apply.env',
        'printf \'{"stage":"apply","status":"refused","refusal":"not-approved","message":"the deploy failed with %s"}\' "$DB_PASSWORD" > .chant/pr/pr-apply.json',
        'printf \'{\\n  "entries": [\\n    { "password": "%s" }\\n  ]\\n}\\n\' "$DB_PASSWORD" > .chant/pr/change-set.json',
        'echo "connecting with $DB_PASSWORD and $MY_API_TOKEN, pin $PIN"',
        'echo "login refused for $DB_PASSWORD" >&2',
        "exit 3",
        "",
      ].join("\n"),
    );
    chmodSync(leaky, 0o755);

    const events: string[] = [];
    const lines: string[] = [];
    const out = join(scratchDir("chant-ci-run-leak-"), "pr");
    const r = await ciRun({
      image: JOB_IMAGE,
      cwd: app,
      job: "apply",
      env: "prod",
      forge: "forgejo",
      base,
      chant: leaky,
      hostEnv: { ...HOST, MY_API_TOKEN: TOKEN },
      passEnv: ["MY_API_TOKEN"],
      secrets,
      runnerKey: BOT.pem,
      push: false,
      output: out,
      runId: "chant-leak-1",
      runEvents: (line) => events.push(line),
      stepOutput: (line) => lines.push(line),
    });
    expect(r.status).toBe("fail");
    const leaks = (text: string): boolean => text.includes(SECRET) || text.includes(TOKEN);

    // The events, as written and as kept on this host, still valid lines.
    expect(events.some(leaks)).toBe(false);
    const stream = checkRunEventLines(events);
    expect(stream.at(-1)).toMatchObject({ type: "run-settle", status: "failed", failure: { code: "not-approved", reason: "the deploy failed with ***" } });
    const kept = readFileSync(join((await runEventsDir(app))!, runEventFileName("chant-leak-1")), "utf-8");
    expect(leaks(kept)).toBe(false);
    expect(kept).toContain("***");

    // The record: the step's error and failure.reason redacted, and the statement still verifies.
    expect(leaks(JSON.stringify(r.record))).toBe(false);
    expect(r.record.failure).toMatchObject({ code: "not-approved", reason: "the deploy failed with ***", exitCode: 3 });
    const stored = (await readRunLedger("prod", "pr-apply", { cwd: app })).records.at(-1)!;
    expect(leaks(JSON.stringify(stored))).toBe(false);
    expect(stored.phases.at(-1)!.steps[0]!.error).toContain("login refused for ***");
    expect(verifyOpRunStatement(stored, RUNNERS, { runner: ["chant-runner"] })).toMatchObject({ status: "signed", signer: "chant-runner" });

    // The copied report and change set: redacted, and still JSON in the layout the job wrote.
    const files = filesUnder(out);
    expect(Object.values(files).some(leaks)).toBe(false);
    expect(JSON.parse(files[join(out, "pr-apply.json")]!)).toMatchObject({ message: "the deploy failed with ***" });
    expect(files[join(out, "change-set.json")]).toBe('{\n  "entries": [\n    {\n      "password": "***"\n    }\n  ]\n}\n');
    expect(envFile(out, "pr-apply")).toMatchObject({ DB_PASSWORD: "***", MY_API_TOKEN: "***" });

    // What ci run prints: the step's lines, the result's failure and the summary. A value under 4 characters is kept.
    expect(lines.some(leaks)).toBe(false);
    expect(lines.some((l) => l.endsWith("| connecting with *** and ***, pin abc"))).toBe(true);
    expect(leaks(r.failure!.error)).toBe(false);
    expect(leaks(formatCiRun(r))).toBe(false);
    expect(formatCiRun(r)).toContain("not-approved in apply, exit 3: the deploy failed with ***");
  });
});
