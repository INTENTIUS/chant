/**
 * `chant ci runner-start` and `chant ci run --require-runner-start` (#4147):
 * the statement checked against `.chant/trust.json` at base, and the
 * readiness the isolated-runners security group reads (#4168).
 */

import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { parseArgs } from "../cli/parse-args";
import type { CommandContext } from "../cli/registry";
import { signRunnerStart, type CiJobIdentity } from "../runner-start";
import { cleanScratch, git, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import { checkRunnerStart, parseJobSpec, requireRunnerStart, runCiRunnerStart, runnerStartReadiness, runnerStartReadinessAt } from "./ci-runner-start";
import { ciRun, CiRunError } from "./ci-run";
import { sshFromEd25519 } from "./trust/dsse";
import { emptyPolicy } from "./trust/policy";

afterAll(cleanScratch);

function key(principal: string): { principal: string; pem: string; ssh: string; signer: Parameters<typeof signRunnerStart>[1] } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as { x: string };
  const ssh = sshFromEd25519(Buffer.from(jwk.x, "base64url"));
  return { principal, pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), ssh, signer: { principal, key: privateKey, publicKey: ssh } };
}

const PROVISIONER = key("provisioner");
const LATER = key("late-provisioner");

/** A repository whose first commit lists PROVISIONER as a runner, and whose second adds LATER. */
function repo(): { root: string; base: string; head: string } {
  const root = scratchDir("chant-runner-start-");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "t");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "commit.gpgsign", "false");
  const trust = (runners: Array<{ principal: string; ssh: string }>) =>
    JSON.stringify({ schema: 1, runners: runners.map((r) => ({ principal: r.principal, class: "runner", key: r.ssh })), roles: { runner: runners.map((r) => r.principal) } });
  writeFiles(root, { ".chant/trust.json": trust([PROVISIONER]) });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "trust");
  const base = git(root, "rev-parse", "HEAD");
  writeFiles(root, { ".chant/trust.json": trust([PROVISIONER, LATER]) });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "a pull request adds its own provisioner");
  return { root, base, head: git(root, "rev-parse", "HEAD") };
}

const R = repo();

const job = (commit: string): CiJobIdentity => ({ system: "github", repo: "acme/infra", run: "4242", attempt: "1", job: "apply", commit, runner: "jit-1" });
const env = (commit: string, statement?: unknown): Record<string, string> => ({
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "acme/infra",
  GITHUB_RUN_ID: "4242",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_JOB: "apply",
  GITHUB_SHA: commit,
  RUNNER_NAME: "jit-1",
  CHANT_RUNNER_START_FILE: "/nonexistent/runner-start.json",
  ...(statement ? { CHANT_RUNNER_START: JSON.stringify(statement) } : {}),
});

describe("checkRunnerStart reads the runner keys at base", () => {
  test("a statement by a provisioner listed at base verifies", () => {
    const v = checkRunnerStart({ top: R.root, base: R.base, env: env(R.head, signRunnerStart(job(R.head), PROVISIONER.signer)) });
    expect(v).toMatchObject({ status: "verified", signer: "provisioner" });
  });

  test("a provisioner the change itself lists does not count at the base before it", () => {
    const statement = signRunnerStart(job(R.head), LATER.signer);
    expect(checkRunnerStart({ top: R.root, base: R.base, env: env(R.head, statement) }).status).toBe("untrusted");
    expect(checkRunnerStart({ top: R.root, base: R.head, env: env(R.head, statement) }).status).toBe("verified");
  });

  test("the job's commit stands in for the forge's variable, so a statement for another commit is refused", () => {
    const statement = signRunnerStart(job(R.head), PROVISIONER.signer);
    expect(checkRunnerStart({ top: R.root, base: R.base, env: env(R.head, statement), commit: R.base }).status).toBe("mismatch");
  });

  test("requireRunnerStart throws with the reason, and a missing statement is named", () => {
    expect(() => requireRunnerStart({ top: R.root, base: R.base, commit: R.head, env: env(R.head) })).toThrow(/--require-runner-start: missing: .*has no runner-start statement/);
    expect(() => requireRunnerStart({ top: R.root, base: R.base, commit: R.head, env: {} })).toThrow(/needs a forge job to check/);
    expect(requireRunnerStart({ top: R.root, base: R.base, commit: R.head, env: env(R.head, signRunnerStart(job(R.head), PROVISIONER.signer)) }).signer).toBe("provisioner");
  });
});

describe("runnerStartReadiness, for the isolated-runners group", () => {
  test("a policy with a runner key whose principal holds the runner role is configured", () => {
    expect(runnerStartReadinessAt(R.root, R.base)).toEqual({ configured: true, gaps: [] });
  });

  test("no runner key, a key with no runner role, and an unreadable policy each name their gap", () => {
    expect(runnerStartReadiness(emptyPolicy("x")).gaps.map((g) => g.code)).toEqual(["runner-start-no-runner-key"]);
    const noRole = { ...emptyPolicy("x"), runners: [{ principal: "p", class: "runner" as const, key: PROVISIONER.ssh }] };
    expect(runnerStartReadiness(noRole)).toMatchObject({ configured: false, gaps: [{ code: "runner-start-no-runner-role" }] });
    expect(runnerStartReadiness(emptyPolicy("x", ["bad json"])).gaps.map((g) => g.code)).toEqual(["runner-start-trust-unreadable"]);
  });
});

describe("chant ci runner-start sign and verify", () => {
  test("--job takes JSON or @file, and refuses fields chant does not know", () => {
    const dir = scratchDir("chant-runner-start-job-");
    writeFiles(dir, { "job.json": JSON.stringify(job(R.head)) });
    expect(parseJobSpec(`@${join(dir, "job.json")}`)).toEqual(job(R.head));
    expect(parseJobSpec('{"system":"gitlab","repo":"g/s/p","run":9,"job":77,"commit":"x"}')).toEqual({ system: "gitlab", repo: "g/s/p", run: "9", attempt: "1", job: "77", commit: "x" });
    expect(() => parseJobSpec('{"system":"github","pr":7}')).toThrow(/fields chant does not know: pr/);
    expect(parseArgs(["ci", "runner-start", "sign", "--key", "k.pem", "--principal", "provisioner", "--job", "@job.json"])).toMatchObject({ path: "runner-start", extraPositional: "sign", key: "k.pem", ciPrincipal: "provisioner", ciJob: "@job.json" });
    expect(parseArgs(["ci", "run", "apply", "--env", "prod", "--require-runner-start"])).toMatchObject({ requireRunnerStart: true });
  });

  test("sign writes an envelope the job then verifies, and verify exits 1 for another attempt", async () => {
    const dir = scratchDir("chant-runner-start-cli-");
    writeFiles(dir, { "key.pem": PROVISIONER.pem, "job.json": JSON.stringify(job(R.head)) });
    const out = join(dir, "runner-start.json");
    const ctx = (argv: string[]) => ({ args: parseArgs(argv) }) as unknown as CommandContext;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runCiRunnerStart(ctx(["ci", "runner-start", "sign", "--key", join(dir, "key.pem"), "--principal", "provisioner", "--job", `@${join(dir, "job.json")}`, "-o", out]))).toBe(0);
      const statement = JSON.parse(readFileSync(out, "utf8"));
      const cwd = process.cwd();
      process.chdir(R.root);
      try {
        vi.stubEnv("GITHUB_ACTIONS", "true");
        for (const [k, v] of Object.entries(env(R.head))) vi.stubEnv(k, v);
        vi.stubEnv("CHANT_RUNNER_START_FILE", out);
        expect(await runCiRunnerStart(ctx(["ci", "runner-start", "verify", "--base", R.base]))).toBe(0);
        vi.stubEnv("GITHUB_RUN_ATTEMPT", "2");
        expect(await runCiRunnerStart(ctx(["ci", "runner-start", "verify", "--base", R.base]))).toBe(1);
      } finally {
        vi.unstubAllEnvs();
        process.chdir(cwd);
      }
      expect(statement.payloadType).toBe("application/vnd.in-toto+json");
      expect(await runCiRunnerStart(ctx(["ci", "runner-start", "nope"]))).toBe(1);
    } finally {
      quiet.mockRestore();
    }
  });
});

describe("ci run --require-runner-start", () => {
  test("a job with no statement is refused before anything runs, and --local is refused with it", async () => {
    const run = (extra: Partial<Parameters<typeof ciRun>[0]>) => ciRun({ cwd: R.root, job: "apply", env: "prod", forge: "github", base: R.base, hostEnv: env(R.head), push: false, requireRunnerStart: true, ...extra });
    await expect(run({})).rejects.toThrow(CiRunError);
    await expect(run({})).rejects.toThrow(/has no runner-start statement/);
    await expect(run({ local: true, hostEnv: {} })).rejects.toThrow(/--local runs the job on this machine/);
  });
});
