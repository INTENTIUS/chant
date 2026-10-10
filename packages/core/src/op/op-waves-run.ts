/**
 * What an Op waves job runs (#3679): `chant run wave --spec <file> --wave <k>`.
 * `./op-waves.ts` holds the spec and the jobs; this plans a wave's runs,
 * decides its gate and applies it.
 *
 * - Plan: each run's `plan` command writes a plan file; its `planDigest` is
 *   the run's member digest, named by its target.
 * - Decide: the wave's policy comes from the spec file at the base commit
 *   (`git show <base>:<file>`), so a change cannot loosen its own gate. A
 *   wave missing there, or a file missing there, is `always`. A wave that
 *   needs an approval waits on `<gate>-wave-<k>` bound to
 *   {@link waveSetDigest} over its members, and exits 3 when nobody approved
 *   that digest.
 * - Which approvals count is the wave's `approval`, read at base like its
 *   policy (#3684): `ledger`, `sealed` or `pr-review` (`./gate-review.ts`).
 *   Under `pr-review` the pull request's pipeline runs `--record-plans`
 *   ({@link recordOpWaveHeadPlans}), which plans every wave at the head and
 *   records the digests a review of that head approves.
 * - Apply: each run's `apply` command. A share job (`--share i`) re-plans its
 *   slice first and refuses, without applying it, a run whose plan digest is
 *   not the one the deciding job recorded (exit 4).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { waveGateName, waveSetDigest, type WaveMember } from "../gated-waves";
import { approveCommand, evaluateGate, gitGateLedgerPort, type GateLedgerPort } from "./gate";
import type { HeadPlans, MergedReview, ReviewSource } from "./gate-review";
import type { TrustPolicy } from "../workspace/trust/policy";
import {
  OP_WAVE_DEFAULT_APPLY,
  OP_WAVE_GATE_POLICIES,
  GATE_APPROVAL_SOURCES,
  assertOpWavesSpec,
  opWaveRecordPath,
  opWaveShare,
  type GateApprovalSource,
  type OpWaveGatePolicy,
  type OpWaveRun,
  type OpWavesSpec,
} from "./op-waves";

/** What a run's plan command writes to `{plan}`. */
export interface OpWavePlanFile {
  planDigest: string;
  /** The plan destroys, rewrites or otherwise needs a person under `on-destructive`. */
  destructive?: boolean;
  /** The plan changes nothing. */
  empty?: boolean;
}

/** One run's plan, as the decision records it. */
export interface OpWaveMember extends WaveMember {
  op: string;
  destructive?: boolean;
  empty?: boolean;
}

/** Where a wave's policy came from. */
export type OpWavePolicySource = "base" | "absent-at-base";

/** A wave's decision: what was planned, the policy, and whether it may apply. */
export interface OpWaveDecision {
  wave: number;
  name: string;
  /** The op the gate is recorded under: the spec's name. */
  op: string;
  gate: string;
  policy: OpWaveGatePolicy;
  /** Which approvals count, read at base with the policy (#3684). */
  approval: GateApprovalSource;
  policySource: OpWavePolicySource;
  /** The base commit the policy was read at. */
  base: string;
  digest: string;
  members: OpWaveMember[];
  /** `approved`: an approval of this digest stands. `not-required`: the policy lets it through. `waiting`: neither. */
  status: "approved" | "not-required" | "waiting";
  approvedBy?: string;
  /** How the approval arrived: a resolution on the ledger, or the merged pull request's review (#3684). */
  via?: "ledger" | "pr-review";
  /** The review that approved the wave, or why the review did not, under `pr-review`. */
  review?: { pr?: number; head?: string; approvers?: string[]; url?: string; reason?: string };
  /** The command that approves this digest, when waiting. */
  approve?: string;
}

/** Runs one argv; returns its exit code. Injected so tests run no processes. */
export type OpWaveExec = (argv: string[], cwd: string) => number;

const spawnExec: OpWaveExec = (argv, cwd) => {
  const result = spawnSync(argv[0]!, argv.slice(1), { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
};

/** Reads one file at one commit, or null when the commit has no such file. Injected for tests. */
export type OpWaveShowAtBase = (base: string, path: string, cwd: string) => { sha: string; text: string | null };

const gitShowAtBase: OpWaveShowAtBase = (base, path, cwd) => {
  let sha: string;
  try {
    sha = execFileSync("git", ["rev-parse", "--verify", `${base}^{commit}`], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new Error(
      `the gate policy is read at ${base}, which this checkout does not have. ` +
        `Check out the full history (fetch-depth: 0 on GitHub and Forgejo, GIT_DEPTH: "0" on GitLab), or set the spec's base.`,
    );
  }
  try {
    const text = execFileSync("git", ["show", `${sha}:./${path}`], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    return { sha, text };
  } catch {
    return { sha, text: null };
  }
};

/** Read a spec file, refusing anything that is not one. */
export function parseOpWavesSpec(text: string, where: string): OpWavesSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${where}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const waves = (parsed as { waves?: unknown } | null)?.waves;
  const spec = (Array.isArray(waves) ? parsed : waves) as OpWavesSpec | undefined;
  if (!spec || typeof spec !== "object" || !Array.isArray(spec.waves)) {
    throw new Error(`${where} must hold an Op waves spec: { "name", "op", "plan", "waves": [...] }, or { "waves": <that>, "options": {...} }`);
  }
  return spec;
}

/**
 * The policy of wave `name`, as the spec file at `base` declares it. The
 * file or the wave missing there reads as `always`: a change that adds a
 * wave, or the file, waits for a person the first time.
 */
export function readOpWavePolicy(
  specFile: string,
  name: string,
  base: string,
  cwd: string,
  show: OpWaveShowAtBase = gitShowAtBase,
): { policy: OpWaveGatePolicy; approval: GateApprovalSource; source: OpWavePolicySource; base: string } {
  const { sha, text } = show(base, specFile.replace(/^\.\//, "").split("\\").join(posix.sep), cwd);
  const absent = { policy: "always" as const, approval: "ledger" as const, source: "absent-at-base" as const, base: sha };
  if (text === null) return absent;
  let spec: OpWavesSpec;
  try {
    spec = parseOpWavesSpec(text, `${specFile} at ${base}`);
  } catch {
    return absent;
  }
  const wave = spec.waves.find((w) => w.name === name);
  if (!wave) return absent;
  const policy = wave.gate ?? "always";
  // An approval mode this chant does not know reads as sealed: the strictest, so an unknown rule never loosens a gate.
  const approval = wave.approval === undefined ? "ledger" : GATE_APPROVAL_SOURCES.includes(wave.approval) ? wave.approval : "sealed";
  return { policy: OP_WAVE_GATE_POLICIES.includes(policy) ? policy : "always", approval, source: "base", base: sha };
}

/** Fill one argv template for one run. */
export function opWaveArgv(template: readonly string[], values: { op: string; target: string; wave: string; plan: string }): string[] {
  return template.map((part) =>
    part.replaceAll("{op}", values.op).replaceAll("{target}", values.target).replaceAll("{wave}", values.wave).replaceAll("{plan}", values.plan),
  );
}

/** Where a run's plan file goes. */
export function opWavePlanPath(spec: Pick<OpWavesSpec, "name">, wave: number, target: string): string {
  return `.chant/op-waves/${spec.name}/wave-${wave}/${target.replace(/[^A-Za-z0-9._-]/g, "_")}.plan.json`;
}

export interface RunOpWaveOptions {
  spec: OpWavesSpec;
  specFile: string;
  /** 1-based. */
  wave: number;
  /** Plan and decide only (a wide wave's deciding job). */
  decide?: boolean;
  /** Apply this 1-based share of a decided wave. */
  share?: number;
  /** Overrides the spec's base. */
  base?: string;
  cwd?: string;
  gates?: GateLedgerPort;
  exec?: OpWaveExec;
  show?: OpWaveShowAtBase;
  now?: string;
  log?: (line: string) => void;
  /** The applied commit, which a `pr-review` gate finds the merged pull request by. Default `git rev-parse HEAD`. */
  head?: string;
  /** The forge's reviews, for a `pr-review` gate. Default: the CI job's forge (`reviewSourceFromEnv`). */
  reviews?: ReviewSource;
  /** The plans recorded for a pull request's head. Default: read from `chant/lifecycle`. */
  headPlans?: (name: string, head: string) => Promise<HeadPlans | null>;
  /** The signers policy at base, for a `sealed` gate. Default: read from the base commit. */
  trust?: (base: string) => TrustPolicy;
}

export interface RunOpWaveResult {
  /** 0 applied (or decided), 1 a run failed, 3 waiting for an approval, 4 a plan moved since the decision. */
  exitCode: number;
  decision?: OpWaveDecision;
  applied: string[];
  failed: string[];
  /** Runs a share job refused because their plan moved since the decision. */
  moved: string[];
}

function planRun(
  opts: Required<Pick<RunOpWaveOptions, "spec" | "wave">> & { cwd: string; exec: OpWaveExec },
  waveName: string,
  run: OpWaveRun,
): OpWaveMember {
  const op = run.op ?? opts.spec.op;
  const plan = opWavePlanPath(opts.spec, opts.wave, run.target);
  mkdirSync(dirname(join(opts.cwd, plan)), { recursive: true });
  const code = opts.exec(opWaveArgv(opts.spec.plan, { op, target: run.target, wave: waveName, plan }), opts.cwd);
  if (code !== 0) throw new Error(`planning ${run.target} exited ${code}`);
  let file: OpWavePlanFile;
  try {
    file = JSON.parse(readFileSync(join(opts.cwd, plan), "utf-8")) as OpWavePlanFile;
  } catch (err) {
    throw new Error(`planning ${run.target} wrote no readable plan file at ${plan}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof file.planDigest !== "string" || file.planDigest === "") {
    throw new Error(`the plan file for ${run.target} (${plan}) has no planDigest`);
  }
  return {
    member: run.target,
    planDigest: file.planDigest,
    op,
    ...(file.destructive === true ? { destructive: true } : {}),
    ...(file.empty === true ? { empty: true } : {}),
  };
}

/** Whether `policy` lets a wave with these members through without an approval. */
export function opWaveNeedsApproval(policy: OpWaveGatePolicy, members: readonly OpWaveMember[]): boolean {
  if (policy === "never") return false;
  if (members.every((m) => m.empty === true)) return false;
  if (policy === "on-destructive") return members.some((m) => m.destructive === true);
  return true;
}

/** Plan, decide and apply one wave, or one part of a wide wave. */
export async function runOpWave(options: RunOpWaveOptions): Promise<RunOpWaveResult> {
  const { spec, wave: k } = options;
  assertOpWavesSpec(spec);
  const cwd = options.cwd ?? process.cwd();
  const exec = options.exec ?? spawnExec;
  const log = options.log ?? ((line: string) => console.error(line));
  const wave = spec.waves[k - 1];
  if (!wave) throw new Error(`Op waves "${spec.name}" has ${spec.waves.length} waves; there is no wave ${k}.`);
  const shares = wave.shares ?? 1;
  if (options.share !== undefined && (options.share < 1 || options.share > shares)) {
    throw new Error(`wave ${k} (${wave.name}) has ${shares} share${shares === 1 ? "" : "s"}; there is no share ${options.share}.`);
  }
  const ctx = { spec, wave: k, cwd, exec };
  const recordPath = join(cwd, opWaveRecordPath(spec, k));
  const result: RunOpWaveResult = { exitCode: 0, applied: [], failed: [], moved: [] };

  if (options.share !== undefined) {
    let decision: OpWaveDecision;
    try {
      decision = JSON.parse(readFileSync(recordPath, "utf-8")) as OpWaveDecision;
    } catch {
      throw new Error(`share ${options.share} of wave ${k} (${wave.name}) found no decision at ${opWaveRecordPath(spec, k)}. Run the deciding job first.`);
    }
    result.decision = decision;
    if (decision.status === "waiting") {
      log(`wave ${k} (${wave.name}) is waiting on ${decision.gate}; nothing applied. ${decision.approve ?? ""}`.trim());
      return { ...result, exitCode: 3 };
    }
    const decided = new Map(decision.members.map((m) => [m.member, m.planDigest]));
    for (const run of opWaveShare(wave.runs, options.share, shares)) {
      const member = planRun(ctx, wave.name, run);
      if (decided.get(run.target) !== member.planDigest) {
        log(
          `${run.target}: its plan moved since wave ${k} was decided, so it was not applied. ` +
            `decided: ${decided.get(run.target) ?? "(not in the decision)"}; planned now: ${member.planDigest}`,
        );
        result.moved.push(run.target);
        continue;
      }
      applyRun(spec, wave.name, k, run, cwd, exec, result, log);
    }
    result.exitCode = result.failed.length > 0 ? 1 : result.moved.length > 0 ? 4 : 0;
    return result;
  }

  const members = wave.runs.map((run) => planRun(ctx, wave.name, run));
  const digest = waveSetDigest(members);
  const { policy, approval, source, base } = readOpWavePolicy(options.specFile, wave.name, options.base ?? spec.base ?? "HEAD^1", cwd, options.show);
  const gate = waveGateName(spec.gate ?? spec.name, k);
  const decision: OpWaveDecision = { wave: k, name: wave.name, op: spec.name, gate, policy, approval, policySource: source, base, digest, members, status: "not-required" };
  if (opWaveNeedsApproval(policy, members)) {
    const ledger = options.gates ?? gitGateLedgerPort({ cwd });
    let port = ledger;
    if (approval === "sealed") {
      // #3684: only an approval sealed by a signer listed at base counts.
      const review = await import("./gate-review");
      const sealed = review.sealedApprovalRule(gate, (options.trust ?? ((b) => review.trustPolicyAt(cwd, b)))(base));
      port = {
        ...ledger,
        async approvalRule(g) {
          const own = (await ledger.approvalRule?.(g)) ?? null;
          return g === gate ? review.bothRules(own, sealed) : own;
        },
      };
    }
    const now = options.now ?? new Date().toISOString();
    const check = await evaluateGate(port, {
      op: spec.name,
      gate,
      planDigest: digest,
      description: `wave ${k} (${wave.name}): ${members.length} run${members.length === 1 ? "" : "s"}, gate ${policy}, approval ${approval}`,
      now,
    });
    if (check.satisfied) {
      decision.status = "approved";
      decision.via = "ledger";
      decision.approvedBy = check.resolution.resolvedBy;
    } else if (approval === "pr-review") {
      const byReview = await approveByReview(options, { op: spec.name, gate, k, digest, cwd, now, port: ledger });
      decision.review = byReview.review;
      if (byReview.approved) {
        decision.status = "approved";
        decision.via = "pr-review";
        decision.approvedBy = byReview.review.approvers!.join(", ");
      } else {
        decision.status = "waiting";
        decision.approve = approveCommand(spec.name, gate, undefined, digest);
      }
    } else {
      decision.status = "waiting";
      decision.approve = approveCommand(spec.name, gate, undefined, digest, approval === "sealed");
    }
  }
  mkdirSync(dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, JSON.stringify(decision, null, 2) + "\n");
  result.decision = decision;
  log(
    `wave ${k} (${wave.name}): gate ${policy} (read at ${base.slice(0, 12)}${source === "absent-at-base" ? ", where the wave is absent" : ""}), ` +
      `digest ${digest}: ${decision.status}${decision.approvedBy ? ` by ${decision.approvedBy}` : ""}` +
      (decision.via === "pr-review" ? ` (review of #${decision.review?.pr})` : ""),
  );
  if (approval === "pr-review" && decision.status === "waiting" && decision.review?.reason) {
    log(`The pull request's review does not approve wave ${k}: ${decision.review.reason}`);
  }
  if (decision.status === "waiting") {
    log(`Nothing in wave ${k} or after it ran. Read the plans, then approve: ${decision.approve} (with --resume, the approval also starts this job again)`);
    return { ...result, exitCode: 3 };
  }
  if (options.decide) return result;
  for (const run of wave.runs) applyRun(spec, wave.name, k, run, cwd, exec, result, log);
  result.exitCode = result.failed.length > 0 ? 1 : 0;
  return result;
}

function applyRun(
  spec: OpWavesSpec,
  waveName: string,
  k: number,
  run: OpWaveRun,
  cwd: string,
  exec: OpWaveExec,
  result: RunOpWaveResult,
  log: (line: string) => void,
): void {
  const op = run.op ?? spec.op;
  const plan = opWavePlanPath(spec, k, run.target);
  const code = exec(opWaveArgv(spec.apply ?? OP_WAVE_DEFAULT_APPLY, { op, target: run.target, wave: waveName, plan }), cwd);
  if (code === 0) result.applied.push(run.target);
  else {
    log(`${run.target}: apply exited ${code}`);
    result.failed.push(run.target);
  }
}

/** What {@link approveByReview} found. */
interface ReviewOutcome {
  approved: boolean;
  review: NonNullable<OpWaveDecision["review"]>;
}

/**
 * Under `pr-review` (#3684): the merged pull request's review approves the
 * wave when a writer other than the author approved its head, and the head
 * planned this wave's digest. The approval is then written to the ledger as a
 * resolution that names the review, so the record says how the wave passed.
 */
async function approveByReview(
  options: RunOpWaveOptions,
  at: { op: string; gate: string; k: number; digest: string; cwd: string; now: string; port: GateLedgerPort },
): Promise<ReviewOutcome> {
  const review = await import("./gate-review");
  const head = options.head ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: at.cwd, encoding: "utf-8" }).trim();
  let merged: MergedReview | null;
  try {
    merged = await (options.reviews ?? review.reviewSourceFromEnv()).mergedReview(head);
  } catch (err) {
    return { approved: false, review: { reason: `the forge's review could not be read: ${err instanceof Error ? err.message : String(err)}` } };
  }
  if (!merged) return { approved: false, review: { reason: `no merged pull request produced ${head.slice(0, 12)}` } };
  const seen = { pr: merged.pr, head: merged.head, ...(merged.url ? { url: merged.url } : {}) };
  if (merged.approvers.length === 0) {
    const why = merged.refused.length > 0 ? merged.refused.join("; ") : "nobody approved it";
    return { approved: false, review: { ...seen, reason: `no writer other than its author approved the head of #${merged.pr}: ${why}` } };
  }
  const plans = await (options.headPlans ?? ((name, h) => readHeadPlans(name, h, at.cwd)))(options.spec.name, merged.head);
  const planned = plans?.waves.find((w) => w.wave === at.k);
  if (!planned) {
    return {
      approved: false,
      review: { ...seen, approvers: merged.approvers, reason: `no plans are recorded for the head ${merged.head.slice(0, 12)} of #${merged.pr} (its pipeline runs \`chant run wave --record-plans\`)` },
    };
  }
  if (planned.digest !== at.digest) {
    return {
      approved: false,
      review: { ...seen, approvers: merged.approvers, reason: `the plan moved after the review: the head planned ${planned.digest}, and the merge plans ${at.digest}` },
    };
  }
  const note = `approved by the review of #${merged.pr} at ${merged.head.slice(0, 12)}: ${merged.approvers.join(", ")}`;
  await at.port.appendResolution?.({
    op: at.op,
    gate: at.gate,
    resolvedBy: merged.approvers[0]!,
    timestamp: at.now,
    planDigest: at.digest,
    approver: { kind: "human" },
    note,
    ...(merged.url ? { url: merged.url } : {}),
    review: { pr: merged.pr, head: merged.head, approvers: merged.approvers },
  });
  return { approved: true, review: { ...seen, approvers: merged.approvers } };
}

async function readHeadPlans(name: string, head: string, cwd: string): Promise<HeadPlans | null> {
  const { readBlobFromPath, requireLifecycleLedger } = await import("../lifecycle/git");
  const { headPlansPath } = await import("./gate-review");
  await requireLifecycleLedger({ cwd });
  const { dir, file } = headPlansPath(name, head);
  const text = await readBlobFromPath(dir, file, { cwd });
  if (!text) return null;
  try {
    return JSON.parse(text) as HeadPlans;
  } catch {
    return null;
  }
}

export interface RecordHeadPlansOptions {
  spec: OpWavesSpec;
  cwd?: string;
  exec?: OpWaveExec;
  /** The commit the plans are for. Default: the pull request's head from the CI job's environment, else `git rev-parse HEAD`. */
  head?: string;
  now?: string;
  /** Write the record. Default: append to `chant/lifecycle` and push. */
  write?: (plans: HeadPlans) => Promise<void>;
}

/**
 * `chant run wave --spec <file> --record-plans` (#3684): plan every wave at a
 * pull request's head and record each wave's digest on `chant/lifecycle`,
 * `_wave-plans/<name>/<head>.json`. A `pr-review` wave reads it after the
 * merge: the review of that head approves the digests it planned, and only
 * those.
 */
export async function recordOpWaveHeadPlans(options: RecordHeadPlansOptions): Promise<HeadPlans> {
  const { spec } = options;
  assertOpWavesSpec(spec);
  const cwd = options.cwd ?? process.cwd();
  const exec = options.exec ?? spawnExec;
  const review = await import("./gate-review");
  const head = options.head ?? review.pullRequestHeadFromEnv() ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf-8" }).trim();
  const plans: HeadPlans = {
    version: 1,
    name: spec.name,
    head,
    timestamp: options.now ?? new Date().toISOString(),
    waves: spec.waves.map((wave, i) => {
      const members = wave.runs.map((run) => planRun({ spec, wave: i + 1, cwd, exec }, wave.name, run));
      return { wave: i + 1, name: wave.name, digest: waveSetDigest(members) };
    }),
  };
  await (options.write ?? ((p) => writeHeadPlans(p, cwd)))(plans);
  return plans;
}

async function writeHeadPlans(plans: HeadPlans, cwd: string): Promise<void> {
  const { pushLifecycle, requireLifecycleLedger, writeBlobToPath } = await import("../lifecycle/git");
  const { headPlansPath } = await import("./gate-review");
  await requireLifecycleLedger({ cwd });
  const { dir, file } = headPlansPath(plans.name, plans.head);
  await writeBlobToPath(dir, file, JSON.stringify(plans, null, 2) + "\n", `Op waves plans of ${plans.name} at ${plans.head.slice(0, 12)}`, { cwd });
  if (!(await pushLifecycle({ cwd }))) throw new Error("the plans were recorded locally only: chant/lifecycle has no remote to push to");
}
