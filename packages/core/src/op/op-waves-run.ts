/**
 * What an Op waves job runs (#3679): `chant run wave --spec <file> --wave <k>`.
 * `./op-waves.ts` holds the spec and the jobs; this plans a wave's runs,
 * decides its gate and applies it.
 *
 * - Plan: each run's `plan` command writes a plan file; its `planDigest` is
 *   the run's member digest, named by its target. With `planWave` (#3762)
 *   one call plans every run and lists each run's plan; the digest and the
 *   decision are the same as from per-run plans.
 * - Hooks (#3762): read at base with the policy, run before and after the
 *   plan and the apply. One with `onFailure: approve` that fails holds the
 *   wave: it waits for an approval of its set digest whatever its policy.
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
 * - Spend (#3784): with `approvals.spend` at base, an approval a wave applied
 *   under counts for nothing, and the wave records each approval it applies
 *   under in `_gates/<name>/applied.jsonl` (`../lifecycle/gate-applied.ts`)
 *   just before it applies (a wide wave's deciding job, before its shares).
 * - Apply: each run's `apply` command, or one `applyWave` call for the
 *   approved set (#3762). A share job (`--share i`) re-plans its
 *   slice first and refuses, without applying it, a run whose plan digest is
 *   not the one the deciding job recorded (exit 4).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { waveGateName, waveSetDigest, type WaveMember } from "../gated-waves";
import type { ReviewApproval } from "../gate-decision";
import { approveCommand, evaluateGate, gitGateLedgerPort, type GateLedgerPort } from "./gate";
import { isApprovalSpent, type AppliedGateRecord } from "../lifecycle/gate-applied";
import type { HeadPlans, MergedReview, ReviewSource } from "./gate-review";
import type { TrustPolicy } from "../workspace/trust/policy";
import {
  OP_WAVE_DEFAULT_APPLY,
  OP_WAVE_GATE_POLICIES,
  OP_WAVE_HOOK_MOMENTS,
  GATE_APPROVAL_SOURCES,
  assertOpWaveHooks,
  assertOpWavesSpec,
  opWaveHooksAt,
  opWaveRecordPath,
  opWaveShare,
  type GateApprovalSource,
  type OpWave,
  type OpWaveGatePolicy,
  type OpWaveHook,
  type OpWaveHookMoment,
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

/** What a wave-level plan command writes to `{plans}` (#3762): one plan per run, by target. The array alone is read too. */
export interface OpWavePlansFile {
  runs: Array<OpWavePlanFile & { target: string }>;
}

/** What chant writes to `{runs}` for a wave-level command or a hook (#3762). */
export interface OpWaveRunsFile {
  /** The wave's name. */
  wave: string;
  /** 1-based. */
  number: number;
  /** The wave's set digest, once it is decided. On `applyWave`, the digest the set was approved or let through at. */
  digest?: string;
  /** Each run, with its plan once planned. On `applyWave`, the runs to apply. */
  runs: Array<{ target: string; op: string; planDigest?: string; destructive?: boolean; empty?: boolean }>;
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
  /** The hooks read at base (#3762), which a wide wave's share jobs run too. Absent when there are none. */
  hooks?: Partial<Record<OpWaveHookMoment, OpWaveHook[]>>;
  /** The `onFailure: approve` hooks that failed: the wave needs an approval whatever its policy (#3762). */
  heldBy?: string[];
  /**
   * Spent approvals (#3784). `base`: the spec at base sets `approvals.spend`,
   * so a spent approval counts for nothing and the approval this wave applies
   * under is recorded. `change`: only the change sets it, so the approval is
   * recorded and spent from the next decision on. Absent: neither.
   */
  spend?: "base" | "change";
  /** The approval's own timestamp: what the applied record names. */
  approvedAt?: string;
  /** When the wave recorded that it applies under the approval, which spent it. */
  spentAt?: string;
}

/** One hook's run (#3762). */
export interface OpWaveHookOutcome {
  moment: OpWaveHookMoment;
  name: string;
  /** The run, for a `perRun` hook. */
  target?: string;
  exit: number;
  outcome: "passed" | "failed" | "held";
}

/** Runs one argv; returns its exit code. `env` is added to the job's environment. Injected so tests run no processes. */
export type OpWaveExec = (argv: string[], cwd: string, env?: Record<string, string>) => number;

const spawnExec: OpWaveExec = (argv, cwd, env) => {
  const result = spawnSync(argv[0]!, argv.slice(1), { cwd, stdio: "inherit", ...(env ? { env: { ...process.env, ...env } } : {}) });
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

/** What {@link readOpWavePolicy} read at base. */
export interface OpWaveBaseRules {
  policy: OpWaveGatePolicy;
  approval: GateApprovalSource;
  source: OpWavePolicySource;
  base: string;
  /** The wave's hooks at base, by moment (#3762): the spec's, then the wave's. None when the file or the wave is absent there. */
  hooks: Record<OpWaveHookMoment, OpWaveHook[]>;
  /** Set when the hooks at base could not be read: none run, and the wave waits for a person. */
  hooksRefused?: string;
  /** The spec at base sets `approvals.spend` (#3784). */
  spend: boolean;
}

const noHooks = (): Record<OpWaveHookMoment, OpWaveHook[]> =>
  Object.fromEntries(OP_WAVE_HOOK_MOMENTS.map((m) => [m, []])) as unknown as Record<OpWaveHookMoment, OpWaveHook[]>;

/**
 * The policy of wave `name`, as the spec file at `base` declares it. The
 * file or the wave missing there reads as `always`: a change that adds a
 * wave, or the file, waits for a person the first time. Its stage hooks are
 * read there too (#3762), so a change cannot add, edit or remove a hook its
 * own apply runs; the file or the wave missing there has none.
 */
export function readOpWavePolicy(
  specFile: string,
  name: string,
  base: string,
  cwd: string,
  show: OpWaveShowAtBase = gitShowAtBase,
): OpWaveBaseRules {
  const { sha, text } = show(base, specFile.replace(/^\.\//, "").split("\\").join(posix.sep), cwd);
  const absent = { policy: "always" as const, approval: "ledger" as const, source: "absent-at-base" as const, base: sha, hooks: noHooks(), spend: false };
  if (text === null) return absent;
  let spec: OpWavesSpec;
  try {
    spec = parseOpWavesSpec(text, `${specFile} at ${base}`);
  } catch {
    return absent;
  }
  // The spend rule is the spec's, so it holds for a wave the base does not have yet.
  const spend = (spec as { approvals?: { spend?: unknown } }).approvals?.spend === true;
  const wave = spec.waves.find((w) => w.name === name);
  if (!wave) return { ...absent, spend };
  const policy = wave.gate ?? "always";
  // An approval mode this chant does not know reads as sealed: the strictest, so an unknown rule never loosens a gate.
  const approval = wave.approval === undefined ? "ledger" : GATE_APPROVAL_SOURCES.includes(wave.approval) ? wave.approval : "sealed";
  const rules: OpWaveBaseRules = { policy: OP_WAVE_GATE_POLICIES.includes(policy) ? policy : "always", approval, source: "base", base: sha, hooks: noHooks(), spend };
  try {
    assertOpWaveHooks(`${specFile} at ${sha.slice(0, 12)}`, spec.hooks);
    assertOpWaveHooks(`${specFile} at ${sha.slice(0, 12)}, wave "${name}"`, wave.hooks);
    rules.hooks = opWaveHooksAt(spec, name);
  } catch (err) {
    // A hook at base no runner can run: none run, and the wave waits for a person rather than going out without them.
    rules.hooksRefused = `the hooks at base cannot be run (${err instanceof Error ? err.message : String(err)})`;
  }
  return rules;
}

/** Fill one argv template. A placeholder whose value is not given is left as it is. */
export function opWaveArgv(
  template: readonly string[],
  values: { op: string; wave: string; target?: string; plan?: string; runs?: string; plans?: string },
): string[] {
  const pairs: Array<[string, string | undefined]> = [
    ["{op}", values.op],
    ["{target}", values.target],
    ["{wave}", values.wave],
    ["{plans}", values.plans],
    ["{plan}", values.plan],
    ["{runs}", values.runs],
  ];
  return template.map((part) => pairs.reduce((out, [key, value]) => (value === undefined ? out : out.replaceAll(key, value)), part));
}

/** Where a run's plan file goes. */
export function opWavePlanPath(spec: Pick<OpWavesSpec, "name">, wave: number, target: string): string {
  return `.chant/op-waves/${spec.name}/wave-${wave}/${target.replace(/[^A-Za-z0-9._-]/g, "_")}.plan.json`;
}

/** Where a wave's runs file goes: the `{runs}` of a wave-level command or a hook (#3762). */
export function opWaveRunsPath(spec: Pick<OpWavesSpec, "name">, wave: number): string {
  return `.chant/op-waves/${spec.name}/wave-${wave}/runs.json`;
}

/** Where a wave-level plan command writes its plans: its `{plans}` (#3762). */
export function opWavePlansPath(spec: Pick<OpWavesSpec, "name">, wave: number): string {
  return `.chant/op-waves/${spec.name}/wave-${wave}/plans.json`;
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
  /** 0 applied (or decided), 1 a run or a hook failed, 3 waiting for an approval, 4 a plan moved since the decision. */
  exitCode: number;
  decision?: OpWaveDecision;
  applied: string[];
  failed: string[];
  /** Runs a share job refused because their plan moved since the decision. */
  moved: string[];
  /** The hooks that ran (#3762). */
  hooks: OpWaveHookOutcome[];
}

/** What one wave job works with. */
interface WaveContext {
  spec: OpWavesSpec;
  k: number;
  wave: OpWave;
  cwd: string;
  exec: OpWaveExec;
  log: (line: string) => void;
  result: RunOpWaveResult;
}

function planRun(opts: { spec: OpWavesSpec; wave: number; cwd: string; exec: OpWaveExec }, waveName: string, run: OpWaveRun): OpWaveMember {
  const op = run.op ?? opts.spec.op;
  const plan = opWavePlanPath(opts.spec, opts.wave, run.target);
  mkdirSync(dirname(join(opts.cwd, plan)), { recursive: true });
  const code = opts.exec(opWaveArgv(opts.spec.plan!, { op, target: run.target, wave: waveName, plan }), opts.cwd);
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
  return member(run.target, op, file);
}

function member(target: string, op: string, file: OpWavePlanFile): OpWaveMember {
  return {
    member: target,
    planDigest: file.planDigest,
    op,
    ...(file.destructive === true ? { destructive: true } : {}),
    ...(file.empty === true ? { empty: true } : {}),
  };
}

/** Write the `{runs}` file: the runs, with their plans once planned. */
function writeRunsFile(
  at: { spec: OpWavesSpec; k: number; wave: OpWave; cwd: string },
  runs: readonly OpWaveRun[],
  members?: ReadonlyMap<string, OpWaveMember>,
  digest?: string,
): string {
  const path = opWaveRunsPath(at.spec, at.k);
  const file: OpWaveRunsFile = {
    wave: at.wave.name,
    number: at.k,
    ...(digest ? { digest } : {}),
    runs: runs.map((run) => {
      const m = members?.get(run.target);
      return {
        target: run.target,
        op: run.op ?? at.spec.op,
        ...(m ? { planDigest: m.planDigest, ...(m.destructive ? { destructive: true } : {}), ...(m.empty ? { empty: true } : {}) } : {}),
      };
    }),
  };
  mkdirSync(dirname(join(at.cwd, path)), { recursive: true });
  writeFileSync(join(at.cwd, path), JSON.stringify(file, null, 2) + "\n");
  return path;
}

/**
 * Plan `runs` of wave `k`: one `plan` call per run, or one `planWave` call
 * for all of them (#3762). A wave plan is written out as each run's plan file
 * too, so a per-run `apply` or hook reads `{plan}` either way.
 */
function planRuns(at: { spec: OpWavesSpec; k: number; wave: OpWave; cwd: string; exec: OpWaveExec }, runs: readonly OpWaveRun[]): OpWaveMember[] {
  const { spec, k, wave, cwd, exec } = at;
  if (!spec.planWave) return runs.map((run) => planRun({ spec, wave: k, cwd, exec }, wave.name, run));
  const runsPath = writeRunsFile(at, runs);
  const plans = opWavePlansPath(spec, k);
  rmSync(join(cwd, plans), { force: true });
  const code = exec(opWaveArgv(spec.planWave, { op: spec.op, wave: wave.name, runs: runsPath, plans }), cwd);
  if (code !== 0) throw new Error(`planning wave ${k} (${wave.name}) exited ${code}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(cwd, plans), "utf-8"));
  } catch (err) {
    throw new Error(`planning wave ${k} (${wave.name}) wrote no readable plans file at ${plans}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const entries = Array.isArray(parsed) ? parsed : (parsed as { runs?: unknown } | null)?.runs;
  if (!Array.isArray(entries)) throw new Error(`the plans file of wave ${k} (${plans}) must hold { "runs": [{ "target", "planDigest" }] }`);
  const wanted = new Set(runs.map((r) => r.target));
  const byTarget = new Map<string, OpWavePlanFile>();
  for (const entry of entries as Array<Partial<OpWavePlanFile & { target: string }>>) {
    const target = entry?.target;
    if (typeof target !== "string" || !wanted.has(target)) {
      throw new Error(`the plans file of wave ${k} (${plans}) plans ${JSON.stringify(target)}, which is not a run it was asked to plan`);
    }
    if (byTarget.has(target)) throw new Error(`the plans file of wave ${k} (${plans}) plans ${target} twice`);
    if (typeof entry.planDigest !== "string" || entry.planDigest === "") throw new Error(`the plans file of wave ${k} (${plans}) has no planDigest for ${target}`);
    byTarget.set(target, entry as OpWavePlanFile);
  }
  const missing = runs.filter((r) => !byTarget.has(r.target)).map((r) => r.target);
  if (missing.length > 0) throw new Error(`the plans file of wave ${k} (${plans}) has no plan for ${missing.join(", ")}`);
  return runs.map((run) => {
    const m = member(run.target, run.op ?? spec.op, byTarget.get(run.target)!);
    const path = join(cwd, opWavePlanPath(spec, k, run.target));
    writeFileSync(path, JSON.stringify({ planDigest: m.planDigest, ...(m.destructive ? { destructive: true } : {}), ...(m.empty ? { empty: true } : {}) }) + "\n");
    return m;
  });
}

/** What one moment's hooks came to. */
interface HooksOutcome {
  /** Set when a hook with `onFailure: fail` failed; the hooks after it did not run. */
  failed?: string;
  /** The `onFailure: approve` hooks that failed. */
  holds: string[];
}

/**
 * Run one moment's hooks (#3762), in order: each once for the wave, or once
 * per run for a `perRun` hook. A hook that fails stops the rest, unless its
 * `onFailure` is `approve`: then it holds the wave and the hooks after it run.
 */
function runHooks(
  ctx: WaveContext,
  moment: OpWaveHookMoment,
  hooks: readonly OpWaveHook[] | undefined,
  runs: readonly OpWaveRun[],
  members?: ReadonlyMap<string, OpWaveMember>,
  digest?: string,
): HooksOutcome {
  const out: HooksOutcome = { holds: [] };
  if (!hooks || hooks.length === 0) return out;
  const { spec, k, wave, cwd, exec, log } = ctx;
  const runsPath = writeRunsFile(ctx, runs, members, digest);
  const env = { CHANT_OP_WAVES: spec.name, CHANT_WAVE: wave.name, CHANT_WAVE_NUMBER: String(k), CHANT_HOOK: moment, CHANT_RUNS: runsPath };
  for (const hook of hooks) {
    const name = hook.name ?? (hook.command.join(" ").length > 60 ? `${hook.command.join(" ").slice(0, 57)}...` : hook.command.join(" "));
    const calls = hook.perRun
      ? runs.map((run) => {
          const plan = members?.has(run.target) ? opWavePlanPath(spec, k, run.target) : undefined;
          return {
            target: run.target as string | undefined,
            argv: opWaveArgv(hook.command, { op: run.op ?? spec.op, wave: wave.name, target: run.target, runs: runsPath, ...(plan ? { plan } : {}) }),
            env: { ...env, CHANT_TARGET: run.target, ...(plan ? { CHANT_PLAN: plan } : {}) } as Record<string, string>,
          };
        })
      : [{ target: undefined, argv: opWaveArgv(hook.command, { op: spec.op, wave: wave.name, runs: runsPath }), env: env as Record<string, string> }];
    for (const call of calls) {
      const label = `${moment} hook ${name}${call.target ? ` (${call.target})` : ""}`;
      let code: number;
      try {
        code = exec(call.argv, cwd, call.env);
      } catch (err) {
        log(`${label} did not run: ${err instanceof Error ? err.message : String(err)}`);
        code = 127;
      }
      const base = { moment, name, ...(call.target ? { target: call.target } : {}), exit: code };
      if (code === 0) {
        ctx.result.hooks.push({ ...base, outcome: "passed" });
        continue;
      }
      if (hook.onFailure === "approve") {
        ctx.result.hooks.push({ ...base, outcome: "held" });
        out.holds.push(label);
        log(`${label} exited ${code}, so wave ${k} (${wave.name}) waits for an approval of its set digest`);
        continue;
      }
      ctx.result.hooks.push({ ...base, outcome: "failed" });
      out.failed = `${label} exited ${code}`;
      log(out.failed);
      return out;
    }
  }
  return out;
}

/** Whether `policy` lets a wave with these members through without an approval. */
export function opWaveNeedsApproval(policy: OpWaveGatePolicy, members: readonly OpWaveMember[]): boolean {
  if (policy === "never") return false;
  if (members.every((m) => m.empty === true)) return false;
  if (policy === "on-destructive") return members.some((m) => m.destructive === true);
  return true;
}

/** Log when the change's hooks are not the ones at base, which are the ones that run. */
function noteHooksAtBase(ctx: WaveContext, atBase: Record<OpWaveHookMoment, OpWaveHook[]>, base: string): void {
  const own = opWaveHooksAt(ctx.spec, ctx.wave.name);
  if (JSON.stringify(own) !== JSON.stringify(atBase)) {
    ctx.log(`wave ${ctx.k} (${ctx.wave.name}): its hooks are read at ${base.slice(0, 12)}, and this change's differ; the ones at base run`);
  }
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
  const recordPath = join(cwd, opWaveRecordPath(spec, k));
  const result: RunOpWaveResult = { exitCode: 0, applied: [], failed: [], moved: [], hooks: [] };
  const ctx: WaveContext = { spec, k, wave, cwd, exec, log, result };

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
    // The share runs the hooks its deciding job read at base, around its own slice.
    const slice = opWaveShare(wave.runs, options.share, shares);
    const before = runHooks(ctx, "before-plan", decision.hooks?.["before-plan"], slice);
    if (before.failed) return failed(ctx, `a hook before the plan failed, so nothing in share ${options.share} of wave ${k} was planned or applied`);
    const members = planRuns(ctx, slice);
    const planned = new Map(members.map((m) => [m.member, m]));
    const after = runHooks(ctx, "after-plan", decision.hooks?.["after-plan"], slice, planned);
    if (after.failed) return failed(ctx, `a hook after the plan failed, so nothing in share ${options.share} of wave ${k} was applied`);
    const decided = new Map(decision.members.map((m) => [m.member, m.planDigest]));
    const unmoved: OpWaveRun[] = [];
    for (const run of slice) {
      const now = planned.get(run.target)!;
      if (decided.get(run.target) !== now.planDigest) {
        log(
          `${run.target}: its plan moved since wave ${k} was decided, so it was not applied. ` +
            `decided: ${decided.get(run.target) ?? "(not in the decision)"}; planned now: ${now.planDigest}`,
        );
        result.moved.push(run.target);
        continue;
      }
      unmoved.push(run);
    }
    await applyStage(options, ctx, decision, unmoved, planned, [...before.holds, ...after.holds]);
    if (result.exitCode === 0 && result.moved.length > 0) result.exitCode = 4;
    return result;
  }

  // The policy, the approval mode and the hooks, read at base before anything runs.
  const rules = readOpWavePolicy(options.specFile, wave.name, options.base ?? spec.base ?? "HEAD^1", cwd, options.show);
  const { policy, approval, source, base } = rules;
  noteHooksAtBase(ctx, rules.hooks, base);
  const holds: string[] = [];
  if (rules.hooksRefused) {
    holds.push(rules.hooksRefused);
    log(`wave ${k} (${wave.name}): ${rules.hooksRefused}, so none run and the wave waits for an approval`);
  }
  const before = runHooks(ctx, "before-plan", rules.hooks["before-plan"], wave.runs);
  if (before.failed) return failed(ctx, `a hook before the plan failed, so nothing in wave ${k} was planned or applied`);
  const members = planRuns(ctx, wave.runs);
  const planned = new Map(members.map((m) => [m.member, m]));
  const digest = waveSetDigest(members);
  const after = runHooks(ctx, "after-plan", rules.hooks["after-plan"], wave.runs, planned, digest);
  if (after.failed) return failed(ctx, `a hook after the plan failed, so nothing in wave ${k} was applied`);
  holds.push(...before.holds, ...after.holds);
  const gate = waveGateName(spec.gate ?? spec.name, k);
  const hooks = Object.fromEntries(Object.entries(rules.hooks).filter(([, list]) => list.length > 0));
  const decision: OpWaveDecision = {
    wave: k,
    name: wave.name,
    op: spec.name,
    gate,
    policy,
    approval,
    policySource: source,
    base,
    digest,
    members,
    status: "not-required",
    ...(Object.keys(hooks).length > 0 ? { hooks } : {}),
    ...(holds.length > 0 ? { heldBy: holds } : {}),
    ...(rules.spend ? { spend: "base" as const } : spec.approvals?.spend === true ? { spend: "change" as const } : {}),
  };
  if (opWaveNeedsApproval(policy, members) || holds.length > 0) await settleGate(options, ctx, decision);
  // A wide wave's shares apply under the deciding job's approval, so it is spent here, once.
  if (options.decide && !(await spendApproval(options, ctx, decision))) return ctx.result;
  mkdirSync(dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, JSON.stringify(decision, null, 2) + "\n");
  result.decision = decision;
  log(
    `wave ${k} (${wave.name}): gate ${policy} (read at ${base.slice(0, 12)}${source === "absent-at-base" ? ", where the wave is absent" : ""}), ` +
      `digest ${digest}: ${decision.status}${decision.approvedBy ? ` by ${decision.approvedBy}` : ""}` +
      (decision.via === "pr-review" ? ` (review of #${decision.review?.pr})` : "") +
      (holds.length > 0 ? `; held by ${holds.join(", ")}` : ""),
  );
  if (approval === "pr-review" && decision.status === "waiting" && decision.review?.reason) {
    log(`The pull request's review does not approve wave ${k}: ${decision.review.reason}`);
  }
  if (decision.status === "waiting") {
    log(`Nothing in wave ${k} or after it ran. Read the plans, then approve: ${decision.approve} (with --resume, the approval also starts this job again)`);
    return { ...result, exitCode: 3 };
  }
  if (options.decide) return result;
  await applyStage(options, ctx, decision, wave.runs, planned, [], recordPath);
  return result;
}

function failed(ctx: WaveContext, line: string): RunOpWaveResult {
  ctx.log(line);
  ctx.result.exitCode = 1;
  return ctx.result;
}

/**
 * Decide whether an approval of the decision's digest stands, whatever its
 * policy: sets its status to `approved` or `waiting`. Called when the policy
 * asks for one, or when a hook holds the wave (#3762).
 */
async function settleGate(options: RunOpWaveOptions, ctx: WaveContext, decision: OpWaveDecision): Promise<void> {
  const { spec, k, wave, cwd } = ctx;
  const { gate, digest, approval, base, policy, members } = decision;
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
  // #3784: under the spend rule at base, an approval a wave already applied under counts for nothing.
  const spent: AppliedGateRecord[] | undefined = decision.spend === "base" ? ((await ledger.readApplied?.(spec.name)) ?? []).filter((a) => a.gate === gate) : undefined;
  const held = decision.heldBy?.length ? `, held by ${decision.heldBy.join(", ")}` : "";
  const check = await evaluateGate(port, {
    op: spec.name,
    gate,
    planDigest: digest,
    description: `wave ${k} (${wave.name}): ${members.length} run${members.length === 1 ? "" : "s"}, gate ${policy}, approval ${approval}${held}`,
    now,
    ...(spent ? { spent } : {}),
  });
  if (check.satisfied) {
    decision.status = "approved";
    decision.via = "ledger";
    decision.approvedBy = check.resolution.resolvedBy;
    decision.approvedAt = check.resolution.timestamp;
    return;
  }
  const used = spent?.filter((a) => isApprovalSpent([a], { gate, planDigest: digest, timestamp: a.approvedAt })).pop();
  if (used) {
    ctx.log(`wave ${k} (${wave.name}): the approval of ${digest} by ${used.approvedBy} at ${used.approvedAt} is spent: a wave applied under it at ${used.timestamp}. Applying it again needs a new approval`);
  }
  if (approval === "pr-review") {
    const byReview = await approveByReview(options, { op: spec.name, gate, k, digest, cwd, now, port: ledger, ...(spent ? { spent } : {}) });
    decision.review = byReview.review;
    if (byReview.approved) {
      decision.status = "approved";
      decision.via = "pr-review";
      decision.approvedBy = byReview.review.approvers!.join(", ");
      decision.approvedAt = now;
      return;
    }
    decision.status = "waiting";
    decision.approve = approveCommand(spec.name, gate, undefined, digest);
    return;
  }
  decision.status = "waiting";
  decision.approve = approveCommand(spec.name, gate, undefined, digest, approval === "sealed");
}

/**
 * Apply `runs` of a decided wave: the before-apply hooks, the apply (one call
 * per run, or one `applyWave` call for the set), then the after-apply hooks.
 * A hook that holds the wave here, or held a share job's plan, makes it wait
 * for an approval of the decided digest unless one already stands.
 */
async function applyStage(
  options: RunOpWaveOptions,
  ctx: WaveContext,
  decision: OpWaveDecision,
  runs: readonly OpWaveRun[],
  planned: ReadonlyMap<string, OpWaveMember>,
  earlierHolds: readonly string[],
  recordPath?: string,
): Promise<void> {
  const { spec, k, wave, cwd, exec, log, result } = ctx;
  if (runs.length === 0) return;
  const before = runHooks(ctx, "before-apply", decision.hooks?.["before-apply"], runs, planned, decision.digest);
  if (before.failed) {
    failed(ctx, `a hook before the apply failed, so nothing in wave ${k} was applied`);
    return;
  }
  const holds = [...earlierHolds, ...before.holds];
  if (holds.length > 0 && decision.status !== "approved") {
    decision.heldBy = [...(decision.heldBy ?? []), ...holds];
    await settleGate(options, ctx, decision);
    if (recordPath) writeFileSync(recordPath, JSON.stringify(decision, null, 2) + "\n");
    if (decision.status === "waiting") {
      log(`wave ${k} (${wave.name}) is held by ${holds.join(", ")}, and nobody approved ${decision.digest}; nothing applied. Approve: ${decision.approve}`);
      result.exitCode = 3;
      return;
    }
    log(`wave ${k} (${wave.name}) is held by ${holds.join(", ")}, and ${decision.approvedBy} approved its digest`);
  }
  if (!(await spendApproval(options, ctx, decision))) return;
  if (recordPath && decision.spentAt) writeFileSync(recordPath, JSON.stringify(decision, null, 2) + "\n");
  if (spec.applyWave) {
    const runsPath = writeRunsFile(ctx, runs, planned, decision.digest);
    let code: number;
    try {
      code = exec(opWaveArgv(spec.applyWave, { op: spec.op, wave: wave.name, runs: runsPath, plans: opWavePlansPath(spec, k) }), cwd);
    } catch (err) {
      log(`applying wave ${k} (${wave.name}) did not run: ${err instanceof Error ? err.message : String(err)}`);
      code = 127;
    }
    if (code === 0) result.applied.push(...runs.map((r) => r.target));
    else {
      log(`wave ${k} (${wave.name}): apply exited ${code}, so none of ${runs.map((r) => r.target).join(", ")} counts as applied`);
      result.failed.push(...runs.map((r) => r.target));
    }
  } else {
    for (const run of runs) applyRun(spec, wave.name, k, run, cwd, exec, result, log);
  }
  if (result.failed.length > 0) {
    result.exitCode = 1;
    return;
  }
  const after = runHooks(ctx, "after-apply", decision.hooks?.["after-apply"], runs, planned, decision.digest);
  if (after.failed) failed(ctx, `wave ${k} (${wave.name}) applied, and then a hook after the apply failed`);
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

/**
 * Record that the wave applies under its approval (#3784), which spends it:
 * one line in `_gates/<name>/applied.jsonl`, before anything applies, as
 * terragucci's wave gate writes it. Only an approved wave under the spend
 * rule records, and only once. False when the line could not be written: the
 * wave then fails and applies nothing, since an apply the record misses
 * would leave its approval standing.
 */
async function spendApproval(options: RunOpWaveOptions, ctx: WaveContext, decision: OpWaveDecision): Promise<boolean> {
  if (!decision.spend || decision.status !== "approved" || decision.spentAt || !decision.approvedAt) return true;
  const { spec, k, wave, cwd, log } = ctx;
  const port = options.gates ?? gitGateLedgerPort({ cwd });
  const now = options.now ?? new Date().toISOString();
  const record: AppliedGateRecord = {
    version: 1,
    kind: "applied",
    op: spec.name,
    gate: decision.gate,
    planDigest: decision.digest,
    approvedAt: decision.approvedAt,
    approvedBy: decision.approvedBy ?? "",
    timestamp: now,
    wave: { number: k, name: wave.name },
    ...(decision.via === "pr-review" && decision.review ? { review: { ...(decision.review.pr !== undefined ? { pr: decision.review.pr } : {}), ...(decision.review.head ? { head: decision.review.head } : {}) } } : {}),
  };
  try {
    if (!port.appendApplied) throw new Error("this gate ledger cannot record an applied approval");
    const pushed = await port.appendApplied(record);
    if (!pushed.pushed && pushed.pushWarning) log(`wave ${k} (${wave.name}): ${pushed.pushWarning}`);
  } catch (err) {
    failed(ctx, `wave ${k} (${wave.name}) could not record that it applies under the approval by ${record.approvedBy}, so nothing applied: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  decision.spentAt = now;
  log(`wave ${k} (${wave.name}) applies under the approval by ${record.approvedBy} at ${record.approvedAt}, which is now spent`);
  return true;
}

/** What {@link approveByReview} found. */
type ReviewOutcome = ReviewApproval;

/**
 * Under `pr-review` (#3684): the merged pull request's review approves the
 * wave when a writer other than the author approved its head, and the head
 * planned this wave's digest. The approval is then written to the ledger as a
 * resolution that names the review, so the record says how the wave passed.
 */
async function approveByReview(
  options: RunOpWaveOptions,
  at: { op: string; gate: string; k: number; digest: string; cwd: string; now: string; port: GateLedgerPort; spent?: readonly AppliedGateRecord[] },
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
  // The head's plans are read only when a writer approved it.
  const plans = merged.approvers.length === 0 ? null : await (options.headPlans ?? ((name, h) => readHeadPlans(name, h, at.cwd)))(options.spec.name, merged.head);
  const { reviewApproval } = await import("../gate-decision");
  const outcome = reviewApproval(merged, plans?.waves.find((w) => w.wave === at.k)?.digest, at.digest);
  if (!outcome.approved) return outcome;
  // #3784: a review a wave already applied this digest under is spent, so it is not recorded again.
  if (at.spent && isApprovalSpent(at.spent, { gate: at.gate, planDigest: at.digest, review: { head: merged.head } })) {
    return {
      approved: false,
      review: { ...outcome.review, reason: `a wave already applied ${at.digest} under the review of #${merged.pr} at ${merged.head.slice(0, 12)}, so the review is spent` },
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
  return outcome;
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
      const members = planRuns({ spec, k: i + 1, wave, cwd, exec }, wave.runs);
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
