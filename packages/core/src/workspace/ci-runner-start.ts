/**
 * `chant ci runner-start sign|verify` and `chant ci run --require-runner-start`
 * (#4147): the runner-start statement (../runner-start.ts) checked against
 * `.chant/trust.json` at base.
 *
 * - `sign` is for the provisioner that starts a runner for one job: it signs
 *   the job's ids with a runner key the job never holds and prints the
 *   envelope, which the provisioner puts where the job looks for it.
 * - `verify` is for the job: it names itself from the forge's variables,
 *   reads the statement, and fails unless a runner key `.chant/trust.json`
 *   at base lists, whose principal holds the `runner` role, signed it for
 *   this job.
 * - `ci run --require-runner-start` makes the same check before the job's
 *   first step, so an apply refuses before it trades for any credentials.
 *
 * Requiring the statement is opt-in (#4156). With nothing asking for it,
 * nothing reads it, and a runner with none never refuses, warns or hides
 * anything.
 *
 * {@link runnerStartReadiness} says whether a repository could require it
 * at base, and what is missing, for the isolated-runners security group
 * (#4168, section 8), whose WSP165 check reports these gaps.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CommandContext } from "../cli/registry";
import { formatError } from "../cli/format";
import {
  ciJobFromEnv,
  RUNNER_START_SIGNER_ROLE,
  signRunnerStart,
  verifyRunnerStartForJob,
  type CiJobIdentity,
  type CiSystem,
  type RunnerStartVerdict,
} from "../runner-start";
import { gitRevisionSource } from "./record-source";
import { gitTop } from "./tree";
import { loadRunnerKey } from "./trust/dsse";
import { emptyPolicy, readTrustPolicy, type TrustPolicy } from "./trust/policy";

/** The policy at `base` in the repository around `cwd`. */
function policyAt(top: string, base: string): TrustPolicy {
  return readTrustPolicy(gitRevisionSource(top, base), base);
}

/**
 * Check this job's runner-start statement against `.chant/trust.json` at
 * `base`. `commit` is the commit the job runs, in place of the forge's
 * variable. Never throws.
 */
export function checkRunnerStart(input: { top: string; base: string; env?: Record<string, string | undefined>; commit?: string; readFile?: (path: string) => string }): RunnerStartVerdict {
  const policy = policyAt(input.top, input.base);
  if (policy.problems.length > 0) return { status: "untrusted", reason: `.chant/trust.json at ${input.base.slice(0, 12)} cannot be read: ${policy.problems.join("; ")}` };
  return verifyRunnerStartForJob({
    runners: policy.runners,
    roles: policy.roles,
    ...(input.env ? { env: input.env } : {}),
    ...(input.commit ? { commit: input.commit } : {}),
    ...(input.readFile ? { readFile: input.readFile } : {}),
  });
}

/** One thing a repository lacks before it can require runner-start statements. */
export interface RunnerStartGap {
  /** Not a read-contract reason code: the isolated-runners group (#4168) maps each to its own security code. */
  gap: "no-runner-key" | "no-runner-role" | "trust-unreadable";
  reason: string;
}

/**
 * Whether `.chant/trust.json` in `policy` lets a job require a runner-start
 * statement: a key under `runners` whose principal holds the `runner` role.
 * `configured` is true when there are no gaps. For the isolated-runners
 * security group (#4168); nothing here refuses or warns.
 */
export function runnerStartReadiness(policy: TrustPolicy): { configured: boolean; gaps: RunnerStartGap[] } {
  const gaps: RunnerStartGap[] = [];
  if (policy.problems.length > 0) {
    gaps.push({ gap: "trust-unreadable", reason: `.chant/trust.json cannot be read: ${policy.problems.join("; ")}` });
    return { configured: false, gaps };
  }
  if (policy.runners.length === 0) {
    gaps.push({ gap: "no-runner-key", reason: ".chant/trust.json lists no key under runners for a provisioner to sign with: chant workspace trust runner add <principal> --key <ssh-ed25519 line>" });
  } else {
    const holders = new Set((policy.roles[RUNNER_START_SIGNER_ROLE] ?? []).map((p) => p.normalize("NFKC").trim().toLowerCase()));
    if (!policy.runners.some((r) => holders.has(r.principal.normalize("NFKC").trim().toLowerCase()))) {
      gaps.push({ gap: "no-runner-role", reason: `no principal under runners holds the ${RUNNER_START_SIGNER_ROLE} role in .chant/trust.json: "roles": { "${RUNNER_START_SIGNER_ROLE}": ["<principal>"] }` });
    }
  }
  return { configured: gaps.length === 0, gaps };
}

/** {@link runnerStartReadiness} for the repository around `cwd` at `base` (default `HEAD`). */
export function runnerStartReadinessAt(cwd: string, base = "HEAD"): { configured: boolean; gaps: RunnerStartGap[] } {
  const top = gitTop(cwd);
  if (!top) return runnerStartReadiness(emptyPolicy(null, [`${cwd} is not in a git repository`]));
  const commit = revParse(top, base);
  return runnerStartReadiness(commit ? policyAt(top, commit) : emptyPolicy(null, [`${base} is not a commit`]));
}

function revParse(top: string, rev: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "-q", `${rev}^{commit}`], { cwd: top, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The base `verify` reads trust at: `--base`, else the remote's default branch, else `HEAD`. */
function verifyBase(top: string, base?: string): string {
  const rev = base ?? (revParse(top, "refs/remotes/origin/HEAD") ? "refs/remotes/origin/HEAD" : "HEAD");
  const commit = revParse(top, rev);
  if (!commit) throw new Error(`--base ${rev} is not a commit in this repository`);
  return commit;
}

/** The job named by `--job`: JSON, or `@<file>` holding it. */
export function parseJobSpec(spec: string): CiJobIdentity {
  const text = spec.startsWith("@") ? readFileSync(resolve(spec.slice(1)), "utf8") : spec;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("--job takes the job as JSON, or @<file> holding it: {\"system\":\"github\",\"repo\":\"owner/name\",\"run\":\"<id>\",\"attempt\":\"1\",\"job\":\"apply\",\"commit\":\"<sha>\",\"runner\":\"<name>\"}");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("--job takes a JSON object");
  const o = raw as Record<string, unknown>;
  const str = (k: string): string | undefined => (o[k] === undefined ? undefined : String(o[k]));
  const known = ["system", "repo", "run", "attempt", "job", "commit", "runner"];
  const extra = Object.keys(o).filter((k) => !known.includes(k));
  if (extra.length > 0) throw new Error(`--job has fields chant does not know: ${extra.join(", ")}`);
  return {
    system: (str("system") ?? "") as CiSystem,
    repo: str("repo") ?? "",
    run: str("run") ?? "",
    attempt: str("attempt") ?? "1",
    job: str("job") ?? "",
    commit: str("commit") ?? "",
    ...(str("runner") ? { runner: str("runner")! } : {}),
  };
}

const USAGE = "chant ci runner-start sign --key <runner key.pem> --principal <name> --job <json|@file> [-o <file>]\n  chant ci runner-start verify [--base <rev>] [--commit <sha>] [--json]";

/** `chant ci runner-start sign|verify`. */
export async function runCiRunnerStart(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const action = args.extraPositional;
  try {
    if (action === "sign") {
      if (!args.key) throw new Error("--key names the provisioner's runner key, an Ed25519 private key in PEM, which the job never holds");
      if (!args.ciPrincipal) throw new Error("--principal names the principal .chant/trust.json lists the key for under runners");
      if (!args.ciJob) throw new Error("--job names the job the runner was started for, as JSON or @<file>");
      const job = parseJobSpec(args.ciJob);
      const pem = readFileSync(resolve(args.key), "utf8");
      const loaded = loadRunnerKey(pem);
      const envelope = signRunnerStart(job, { principal: args.ciPrincipal, key: loaded.key, publicKey: loaded.publicKey });
      const text = `${JSON.stringify(envelope)}\n`;
      if (args.output) writeFileSync(resolve(args.output), text, { mode: 0o644 });
      else process.stdout.write(text);
      return 0;
    }
    if (action === "verify") {
      const top = gitTop(process.cwd());
      if (!top) throw new Error("verify reads .chant/trust.json at a commit, and this directory is not in a git repository");
      const base = verifyBase(top, args.base);
      const verdict = checkRunnerStart({ top, base, ...(args.commit ? { commit: args.commit } : {}) });
      if (args.json) process.stdout.write(`${JSON.stringify({ ...verdict, base })}\n`);
      else console.error(`ci runner-start: ${verdict.status}: ${verdict.reason}`);
      return verdict.status === "verified" ? 0 : 1;
    }
    throw new Error(`ci runner-start takes sign or verify${action ? `, not ${JSON.stringify(action)}` : ""}`);
  } catch (err) {
    console.error(formatError({ message: `chant ci runner-start: ${err instanceof Error ? err.message : String(err)}`, hint: USAGE }));
    return 1;
  }
}

/**
 * The check `ci run --require-runner-start` makes before the job's first
 * step: the statement for this job, verified against `.chant/trust.json` at
 * `base`. Throws with the verdict's reason unless it verified.
 */
export function requireRunnerStart(input: { top: string; base: string; commit: string; env: Record<string, string | undefined> }): Extract<RunnerStartVerdict, { status: "verified" }> {
  const named = ciJobFromEnv(input.env);
  if (!named.ok) throw new Error(`--require-runner-start needs a forge job to check: ${named.reason}`);
  const verdict = checkRunnerStart({ top: input.top, base: input.base, env: input.env, commit: input.commit });
  if (verdict.status !== "verified") throw new Error(`--require-runner-start: ${verdict.status}: ${verdict.reason}`);
  return verdict;
}
