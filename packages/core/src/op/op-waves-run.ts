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
 * - Hooks file (#3804): every apply call gets `CHANT_HOOKS`, a JSON file
 *   ({@link OpWaveHooksFile}) with the outcomes of the hooks that already ran
 *   and whether an approval stands. Under `hooks.apply.runBy: "apply"` (read
 *   at base) chant does not run the apply-stage hooks itself: the file hands
 *   them to the apply, which runs them under its own lock with
 *   {@link runOpWaveApplyHooks}, and their outcomes come back through
 *   `CHANT_HOOKS_RESULT`. A non-wave apply reads the same hooks at base with
 *   {@link opWaveHooksAtBase}.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix } from "node:path";
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
  opWaveApplyHooksRunBy,
  opWaveHooksAt,
  opWaveRecordPath,
  opWaveShare,
  type GateApprovalSource,
  type OpWave,
  type OpWaveApplyHooksRunner,
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
  /** `apply`: the apply command runs the apply-stage hooks under its own lock (#3804), as read at base. Absent: chant runs them. */
  applyHooksRunBy?: "apply";
  /** Every hook's outcome so far in the job that wrote the record (#3804). */
  outcomes?: OpWaveHookOutcome[];
}

/** One hook's run (#3762). */
export interface OpWaveHookOutcome {
  moment: OpWaveHookMoment;
  name: string;
  /** The run, for a `perRun` hook. */
  target?: string;
  exit: number;
  outcome: "passed" | "failed" | "held" | "skipped";
  /** Why the moment was skipped, for `skipped` (#3811). */
  reason?: string;
}

/** One run as a hook sees it (#3804). */
export interface OpWaveHookRun {
  target: string;
  op: string;
  /** The run's plan file, once planned. */
  plan?: string;
}

/**
 * What chant hands an apply command in `CHANT_HOOKS` (#3804), and what
 * {@link opWaveHooksAtBase} builds for an apply outside the waves. Paths are
 * relative to the job's working directory.
 */
export interface OpWaveHooksFile {
  version: 1;
  /** The Op waves spec's name. */
  opWaves: string;
  /** The spec's `op`: a hook's `{op}` when it runs once for the wave. */
  op: string;
  wave: string;
  /** 1-based; 0 when the working tree's spec has no such wave. */
  number: number;
  /** The commit the hooks were read at. */
  base?: string;
  /** The wave's set digest, once decided. */
  digest?: string;
  /** An approval of the digest stands, so a held hook does not stop the apply. */
  approved: boolean;
  /** The labels of the hooks that held the wave, approved or not. */
  heldBy?: string[];
  /** Who runs the apply-stage hooks. With `chant`, `hooks` is empty: chant runs them around the apply. */
  runBy: OpWaveApplyHooksRunner;
  /** The runs this apply call applies. */
  runs: OpWaveHookRun[];
  /** The runs file, a hook's `{runs}` and `CHANT_RUNS`. */
  runsFile: string;
  /** The hooks the apply runs, by moment, as read at base. */
  hooks: Partial<Record<OpWaveHookMoment, OpWaveHook[]>>;
  /** The hooks that already ran for this wave in this job, and how each came out. */
  outcomes: OpWaveHookOutcome[];
  /** Where {@link runOpWaveApplyHooks} writes its outcomes (`CHANT_HOOKS_RESULT`), which chant reads back. */
  result?: string;
  /** Set when the hooks at base could not be read: none run, and the runner refuses to proceed. */
  refused?: string;
}

/** What {@link runOpWaveApplyHooks} writes to `CHANT_HOOKS_RESULT` (#3804). */
export interface OpWaveHooksResult {
  version: 1;
  /** The moments the apply ran, empty ones included. */
  moments: OpWaveHookMoment[];
  outcomes: OpWaveHookOutcome[];
}

/** One call of {@link runOpWaveApplyHooks}. */
export interface OpWaveApplyHooksRun {
  moment: OpWaveHookMoment;
  outcomes: OpWaveHookOutcome[];
  /** Set when a hook with `onFailure: fail` failed; the hooks after it did not run. */
  failed?: string;
  /** The `onFailure: approve` hooks that failed, or why the hooks could not be read at base. */
  held: string[];
  /**
   * Whether the apply may go on: no hook failed, and nothing held it or an
   * approval of the digest stands. When false after a hold, the apply applies
   * nothing and exits non-zero; chant then waits for, or finds, an approval
   * and calls it again.
   */
  proceed: boolean;
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
  /** Who runs the apply-stage hooks, as read at base (#3804). `chant` when the file, the wave or the hooks are missing there. */
  applyHooksRunBy: OpWaveApplyHooksRunner;
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
  const absent = { policy: "always" as const, approval: "ledger" as const, source: "absent-at-base" as const, base: sha, hooks: noHooks(), spend: false, applyHooksRunBy: "chant" as const };
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
  const rules: OpWaveBaseRules = { policy: OP_WAVE_GATE_POLICIES.includes(policy) ? policy : "always", approval, source: "base", base: sha, hooks: noHooks(), spend, applyHooksRunBy: "chant" };
  try {
    assertOpWaveHooks(`${specFile} at ${sha.slice(0, 12)}`, spec.hooks);
    assertOpWaveHooks(`${specFile} at ${sha.slice(0, 12)}, wave "${name}"`, wave.hooks);
    rules.hooks = opWaveHooksAt(spec, name);
    rules.applyHooksRunBy = opWaveApplyHooksRunBy(spec, name);
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
  path: string = opWaveRunsPath(at.spec, at.k),
): string {
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

/** Where hooks run: the wave they belong to and the job's tools. */
interface HookPlace {
  /** The spec's name and `op`. */
  name: string;
  op: string;
  waveName: string;
  k: number;
  cwd: string;
  exec: OpWaveExec;
  log: (line: string) => void;
}

/**
 * Run one moment's hooks, in order: each once for the wave, or once per run
 * for a `perRun` hook. A hook that fails stops the rest, unless its
 * `onFailure` is `approve`: then it holds the wave and the hooks after it run.
 */
function runHookList(
  at: HookPlace,
  moment: OpWaveHookMoment,
  hooks: readonly OpWaveHook[] | undefined,
  runs: readonly OpWaveHookRun[],
  runsPath: string,
): HooksOutcome & { outcomes: OpWaveHookOutcome[] } {
  const out: HooksOutcome & { outcomes: OpWaveHookOutcome[] } = { holds: [], outcomes: [] };
  if (!hooks || hooks.length === 0) return out;
  const { name: specName, op, waveName, k, cwd, exec, log } = at;
  const env = { CHANT_OP_WAVES: specName, CHANT_WAVE: waveName, CHANT_WAVE_NUMBER: String(k), CHANT_HOOK: moment, CHANT_RUNS: runsPath };
  for (const hook of hooks) {
    const name = hook.name ?? (hook.command.join(" ").length > 60 ? `${hook.command.join(" ").slice(0, 57)}...` : hook.command.join(" "));
    const calls = hook.perRun
      ? runs.map((run) => ({
          target: run.target as string | undefined,
          argv: opWaveArgv(hook.command, { op: run.op, wave: waveName, target: run.target, runs: runsPath, ...(run.plan ? { plan: run.plan } : {}) }),
          env: { ...env, CHANT_TARGET: run.target, ...(run.plan ? { CHANT_PLAN: run.plan } : {}) } as Record<string, string>,
        }))
      : [{ target: undefined, argv: opWaveArgv(hook.command, { op, wave: waveName, runs: runsPath }), env: env as Record<string, string> }];
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
        out.outcomes.push({ ...base, outcome: "passed" });
        continue;
      }
      if (hook.onFailure === "approve") {
        out.outcomes.push({ ...base, outcome: "held" });
        out.holds.push(label);
        log(`${label} exited ${code}, so wave ${k} (${waveName}) waits for an approval of its set digest`);
        continue;
      }
      out.outcomes.push({ ...base, outcome: "failed" });
      out.failed = `${label} exited ${code}`;
      log(out.failed);
      return out;
    }
  }
  return out;
}

const placeOf = (ctx: WaveContext): HookPlace => ({ name: ctx.spec.name, op: ctx.spec.op, waveName: ctx.wave.name, k: ctx.k, cwd: ctx.cwd, exec: ctx.exec, log: ctx.log });

const hookRuns = (spec: OpWavesSpec, k: number, runs: readonly OpWaveRun[], members?: ReadonlyMap<string, OpWaveMember>): OpWaveHookRun[] =>
  runs.map((run) => ({ target: run.target, op: run.op ?? spec.op, ...(members?.has(run.target) ? { plan: opWavePlanPath(spec, k, run.target) } : {}) }));

/** Run one moment's hooks in the wave job (#3762), recording each outcome on the result. */
function runHooks(
  ctx: WaveContext,
  moment: OpWaveHookMoment,
  hooks: readonly OpWaveHook[] | undefined,
  runs: readonly OpWaveRun[],
  members?: ReadonlyMap<string, OpWaveMember>,
  digest?: string,
): HooksOutcome {
  if (!hooks || hooks.length === 0) return { holds: [] };
  const runsPath = writeRunsFile(ctx, runs, members, digest);
  const out = runHookList(placeOf(ctx), moment, hooks, hookRuns(ctx.spec, ctx.k, runs, members), runsPath);
  ctx.result.hooks.push(...out.outcomes);
  return { holds: out.holds, ...(out.failed ? { failed: out.failed } : {}) };
}

/**
 * Read the hooks file chant hands an apply command (#3804): the one at
 * `path`, by default `CHANT_HOOKS`. Null when there is none, as for an apply
 * that a wave job did not start.
 */
export function readOpWaveHooksFile(path: string | undefined = process.env.CHANT_HOOKS, cwd: string = process.cwd()): OpWaveHooksFile | null {
  if (!path) return null;
  const at = isAbsolute(path) ? path : join(cwd, path);
  let parsed: OpWaveHooksFile;
  try {
    parsed = JSON.parse(readFileSync(at, "utf-8")) as OpWaveHooksFile;
  } catch (err) {
    throw new Error(`the hooks file ${path} cannot be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed?.version !== 1 || !Array.isArray(parsed.runs) || typeof parsed.hooks !== "object") throw new Error(`${path} is not an Op waves hooks file (version 1)`);
  return parsed;
}

/**
 * Run one moment's hooks from a hooks file (#3804): what an apply command
 * calls under its own lock, `before-apply` right before it changes anything
 * and `after-apply` once it has, when the spec's `hooks.apply.runBy` at base
 * is `apply`. Also what a product's apply outside the waves calls, with a
 * file from {@link opWaveHooksAtBase}. A moment the file has no hooks for
 * runs nothing and proceeds, so an apply can call it whoever runs the hooks.
 *
 * Each call adds its outcomes to the file's `result` (`CHANT_HOOKS_RESULT`),
 * which chant reads back after the apply exits: the outcomes join the wave's
 * result and decision record, and a hold makes the wave wait for, or find,
 * an approval of its digest. `skip: "<reason>"` runs nothing and records the
 * moment as skipped with the reason (#3811), for an apply that changes nothing:
 * chant counts the moment as handled. A skip without a reason throws. `exec` runs one hook; inject it to run a hook
 * in process or to keep its output.
 */
export function runOpWaveApplyHooks(
  file: OpWaveHooksFile,
  moment: OpWaveHookMoment,
  options: { cwd?: string; exec?: OpWaveExec; log?: (line: string) => void; skip?: string } = {},
): OpWaveApplyHooksRun {
  const cwd = options.cwd ?? process.cwd();
  const log = options.log ?? ((line: string) => console.error(line));
  let run: OpWaveApplyHooksRun;
  if (options.skip !== undefined) {
    const reason = options.skip.trim();
    if (!reason) throw new Error(`skipping the ${moment} hooks needs a reason (skip: "nothing to apply")`);
    log(`${moment} hooks skipped: ${reason}`);
    run = { moment, outcomes: [{ moment, name: "skip", exit: 0, outcome: "skipped", reason }], held: [], proceed: true };
  } else if (file.refused) {
    log(`${file.refused}, so none of the ${moment} hooks run and the apply does not go on`);
    run = { moment, outcomes: [], held: [file.refused], proceed: false };
  } else {
    const place: HookPlace = { name: file.opWaves, op: file.op, waveName: file.wave, k: file.number, cwd, exec: options.exec ?? spawnExec, log };
    const out = runHookList(place, moment, file.hooks[moment], file.runs, file.runsFile);
    run = {
      moment,
      outcomes: out.outcomes,
      ...(out.failed ? { failed: out.failed } : {}),
      held: out.holds,
      proceed: !out.failed && (out.holds.length === 0 || file.approved),
    };
  }
  if (file.result) {
    const at = isAbsolute(file.result) ? file.result : join(cwd, file.result);
    let prior: OpWaveHooksResult = { version: 1, moments: [], outcomes: [] };
    if (existsSync(at)) {
      try {
        prior = JSON.parse(readFileSync(at, "utf-8")) as OpWaveHooksResult;
      } catch {
        // A result file that cannot be read is started again.
      }
    }
    const next: OpWaveHooksResult = { version: 1, moments: [...prior.moments, moment], outcomes: [...prior.outcomes, ...run.outcomes] };
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, JSON.stringify(next, null, 2) + "\n");
  }
  return run;
}

/**
 * The hooks of wave `wave` read at base, for an apply outside the waves
 * (#3804): a product's own `apply <env>` that runs the same Op as the wave
 * does, and the same hooks. All four moments are in the file; the apply runs
 * the ones it has a stage for with {@link runOpWaveApplyHooks}. Nothing is
 * approved: a held hook stops the apply. The wave or the file missing at
 * base has no hooks, as in a wave job.
 */
export function opWaveHooksAtBase(options: {
  specFile: string;
  wave: string;
  /** The runs this apply applies. Default: the wave's runs in the working tree's spec. */
  runs?: ReadonlyArray<{ target: string; op?: string }>;
  /** Default: the spec's `base`, else `HEAD^1`. */
  base?: string;
  cwd?: string;
  show?: OpWaveShowAtBase;
}): OpWaveHooksFile {
  const cwd = options.cwd ?? process.cwd();
  const spec = parseOpWavesSpec(readFileSync(isAbsolute(options.specFile) ? options.specFile : join(cwd, options.specFile), "utf-8"), options.specFile);
  const k = spec.waves.findIndex((w) => w.name === options.wave) + 1;
  const rules = readOpWavePolicy(options.specFile, options.wave, options.base ?? spec.base ?? "HEAD^1", cwd, options.show);
  const runs = (options.runs ?? spec.waves[k - 1]?.runs ?? []).map((r) => ({ target: r.target, op: r.op ?? spec.op }));
  const runsFile = `.chant/op-waves/${spec.name}/${options.wave.replace(/[^A-Za-z0-9._-]/g, "_")}.runs.json`;
  const runsBody: OpWaveRunsFile = { wave: options.wave, number: k, runs };
  mkdirSync(dirname(join(cwd, runsFile)), { recursive: true });
  writeFileSync(join(cwd, runsFile), JSON.stringify(runsBody, null, 2) + "\n");
  const hooks = Object.fromEntries(Object.entries(rules.hooks).filter(([, list]) => list.length > 0));
  return {
    version: 1,
    opWaves: spec.name,
    op: spec.op,
    wave: options.wave,
    number: k,
    base: rules.base,
    approved: false,
    runBy: "apply",
    runs,
    runsFile,
    hooks,
    outcomes: [],
    ...(rules.hooksRefused ? { refused: rules.hooksRefused } : {}),
  };
}

/** Whether `policy` lets a wave with these members through without an approval. */
export function opWaveNeedsApproval(policy: OpWaveGatePolicy, members: readonly OpWaveMember[]): boolean {
  if (policy === "never") return false;
  if (members.every((m) => m.empty === true)) return false;
  if (policy === "on-destructive") return members.some((m) => m.destructive === true);
  return true;
}

/** Log when the change's hooks are not the ones at base, which are the ones that run. */
function noteHooksAtBase(ctx: WaveContext, rules: OpWaveBaseRules): void {
  const { hooks: atBase, base } = rules;
  const own = opWaveHooksAt(ctx.spec, ctx.wave.name);
  if (JSON.stringify(own) !== JSON.stringify(atBase) || opWaveApplyHooksRunBy(ctx.spec, ctx.wave.name) !== rules.applyHooksRunBy) {
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
  noteHooksAtBase(ctx, rules);
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
    ...(rules.applyHooksRunBy === "apply" ? { applyHooksRunBy: "apply" as const } : {}),
  };
  if (opWaveNeedsApproval(policy, members) || holds.length > 0) await settleGate(options, ctx, decision);
  // A wide wave's shares apply under the deciding job's approval, so it is spent here, once.
  if (options.decide && !(await spendApproval(options, ctx, decision))) return ctx.result;
  mkdirSync(dirname(recordPath), { recursive: true });
  writeRecord(recordPath, decision, result);
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

/** Write the decision record, with every hook's outcome so far (#3804). */
function writeRecord(recordPath: string, decision: OpWaveDecision, result: RunOpWaveResult): void {
  if (result.hooks.length > 0) decision.outcomes = [...result.hooks];
  writeFileSync(recordPath, JSON.stringify(decision, null, 2) + "\n");
}

/**
 * A hold waits only when nobody approved the decided digest: settle the gate
 * once for `holds`. False when the wave now waits (exit 3).
 */
async function settleHolds(
  options: RunOpWaveOptions,
  ctx: WaveContext,
  decision: OpWaveDecision,
  holds: readonly string[],
  recordPath?: string,
): Promise<boolean> {
  const { k, wave, log, result } = ctx;
  if (holds.length === 0 || decision.status === "approved") return true;
  decision.heldBy = [...(decision.heldBy ?? []), ...holds];
  await settleGate(options, ctx, decision);
  if (recordPath) writeRecord(recordPath, decision, result);
  if (decision.status === "waiting") {
    log(`wave ${k} (${wave.name}) is held by ${holds.join(", ")}, and nobody approved ${decision.digest}; nothing applied. Approve: ${decision.approve}`);
    result.exitCode = 3;
    return false;
  }
  log(`wave ${k} (${wave.name}) is held by ${holds.join(", ")}, and ${decision.approvedBy} approved its digest`);
  return true;
}

/** How one apply call came out. `applied` with a `problem`: the runs applied, and the wave still fails. */
type ApplyCall = { outcome: "applied"; problem?: string } | { outcome: "failed" | "waiting" };

/**
 * Call one apply command (#3804) with `CHANT_HOOKS` and `CHANT_HOOKS_RESULT`.
 * When the apply runs the apply-stage hooks, read their outcomes back: a hold
 * with no approval standing settles the gate and, once approved, calls the
 * apply again; an `after-apply` failure means the runs applied and the wave
 * fails; an apply that exited 0 without running its hooks fails the wave.
 */
async function callApply(
  options: RunOpWaveOptions,
  ctx: WaveContext,
  decision: OpWaveDecision,
  runs: readonly OpWaveRun[],
  planned: ReadonlyMap<string, OpWaveMember>,
  argv: string[],
  call: { label: string; key: string; runsPath: string },
  recordPath?: string,
): Promise<ApplyCall> {
  const { spec, k, wave, cwd, exec, log, result } = ctx;
  const byApply = decision.applyHooksRunBy === "apply";
  const dir = `.chant/op-waves/${spec.name}/wave-${k}`;
  const filePath = `${dir}/${call.key}.json`;
  const resultPath = `${dir}/${call.key}-result.json`;
  const handed: Partial<Record<OpWaveHookMoment, OpWaveHook[]>> = {};
  if (byApply) {
    for (const m of ["before-apply", "after-apply"] as const) if (decision.hooks?.[m]?.length) handed[m] = decision.hooks[m];
  }
  for (let pass = 0; pass < 2; pass++) {
    const approved = decision.status === "approved";
    const file: OpWaveHooksFile = {
      version: 1,
      opWaves: spec.name,
      op: spec.op,
      wave: wave.name,
      number: k,
      base: decision.base,
      digest: decision.digest,
      approved,
      ...(decision.heldBy?.length ? { heldBy: decision.heldBy } : {}),
      runBy: byApply ? "apply" : "chant",
      runs: hookRuns(spec, k, runs, planned),
      runsFile: call.runsPath,
      hooks: handed,
      outcomes: [...result.hooks],
      ...(byApply ? { result: resultPath } : {}),
    };
    mkdirSync(join(cwd, dir), { recursive: true });
    writeFileSync(join(cwd, filePath), JSON.stringify(file, null, 2) + "\n");
    rmSync(join(cwd, resultPath), { force: true });
    let code: number;
    try {
      code = exec(argv, cwd, { CHANT_HOOKS: filePath, ...(byApply ? { CHANT_HOOKS_RESULT: resultPath } : {}) });
    } catch (err) {
      log(`${call.label}: the apply did not run: ${err instanceof Error ? err.message : String(err)}`);
      code = 127;
    }
    if (!byApply) return { outcome: code === 0 ? "applied" : "failed" };
    let back: OpWaveHooksResult | null = null;
    try {
      back = JSON.parse(readFileSync(join(cwd, resultPath), "utf-8")) as OpWaveHooksResult;
    } catch {
      back = null;
    }
    const outcomes = Array.isArray(back?.outcomes) ? back!.outcomes : [];
    const moments = Array.isArray(back?.moments) ? back!.moments : [];
    result.hooks.push(...outcomes);
    const holds = outcomes.filter((o) => o.moment === "before-apply" && o.outcome === "held").map((o) => `${o.moment} hook ${o.name}${o.target ? ` (${o.target})` : ""}`);
    if (holds.length > 0 && !approved) {
      if (code === 0) {
        log(`${call.label}: the apply exited 0 although ${holds.join(", ")} held it and no approval stood; an apply applies nothing on a hold`);
        return { outcome: "failed" };
      }
      if (pass > 0 || !(await settleHolds(options, ctx, decision, holds, recordPath))) return { outcome: "waiting" };
      if (!(await spendApproval(options, ctx, decision))) return { outcome: "failed" };
      if (recordPath && decision.spentAt) writeRecord(recordPath, decision, result);
      continue;
    }
    const afterFailed = outcomes.find((o) => o.moment === "after-apply" && o.outcome === "failed");
    if (afterFailed) return { outcome: "applied", problem: `${call.label} applied, and then the after-apply hook ${afterFailed.name} failed` };
    if (code !== 0) return { outcome: "failed" };
    const skipped = (["before-apply", "after-apply"] as const).filter((m) => handed[m] && !moments.includes(m));
    if (skipped.length > 0) {
      return { outcome: "applied", problem: `${call.label}: the apply exited 0 without running its ${skipped.join(" and ")} hooks (runOpWaveApplyHooks with CHANT_HOOKS), which the spec at base hands it` };
    }
    return { outcome: "applied" };
  }
  return { outcome: "failed" };
}

/**
 * Apply `runs` of a decided wave: the before-apply hooks, the apply (one call
 * per run, or one `applyWave` call for the set), then the after-apply hooks.
 * A hook that holds the wave here, or held a share job's plan, makes it wait
 * for an approval of the decided digest unless one already stands. Under
 * `hooks.apply.runBy: "apply"` the apply call runs the apply-stage hooks
 * itself, under its lock (#3804).
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
  const { spec, k, wave, log, result } = ctx;
  if (runs.length === 0) return;
  const byApply = decision.applyHooksRunBy === "apply";
  const holds = [...earlierHolds];
  if (!byApply) {
    const before = runHooks(ctx, "before-apply", decision.hooks?.["before-apply"], runs, planned, decision.digest);
    if (before.failed) {
      failed(ctx, `a hook before the apply failed, so nothing in wave ${k} was applied`);
      return;
    }
    holds.push(...before.holds);
  }
  if (!(await settleHolds(options, ctx, decision, holds, recordPath))) return;
  if (!(await spendApproval(options, ctx, decision))) return;
  if (recordPath && decision.spentAt) writeRecord(recordPath, decision, result);
  const problems: string[] = [];
  let waiting = false;
  if (spec.applyWave) {
    const runsPath = writeRunsFile(ctx, runs, planned, decision.digest);
    const argv = opWaveArgv(spec.applyWave, { op: spec.op, wave: wave.name, runs: runsPath, plans: opWavePlansPath(spec, k) });
    const got = await callApply(options, ctx, decision, runs, planned, argv, { label: `wave ${k} (${wave.name})`, key: "hooks", runsPath }, recordPath);
    if (got.outcome === "applied") {
      result.applied.push(...runs.map((r) => r.target));
      if (got.problem) problems.push(got.problem);
    } else if (got.outcome === "waiting") waiting = true;
    else {
      log(`wave ${k} (${wave.name}): apply failed, so none of ${runs.map((r) => r.target).join(", ")} counts as applied`);
      result.failed.push(...runs.map((r) => r.target));
    }
  } else {
    for (const run of runs) {
      const key = run.target.replace(/[^A-Za-z0-9._-]/g, "_");
      // Under runBy "apply" each run's apply runs its own apply-stage hooks, over a runs file of that run alone.
      const runsPath = byApply ? writeRunsFile(ctx, [run], planned, decision.digest, `.chant/op-waves/${spec.name}/wave-${k}/${key}.runs.json`) : opWaveRunsPath(spec, k);
      const argv = opWaveArgv(spec.apply ?? OP_WAVE_DEFAULT_APPLY, { op: run.op ?? spec.op, target: run.target, wave: wave.name, plan: opWavePlanPath(spec, k, run.target) });
      const got = await callApply(options, ctx, decision, [run], planned, argv, { label: run.target, key: `${key}.hooks`, runsPath }, recordPath);
      if (got.outcome === "waiting") {
        waiting = true;
        break;
      }
      if (got.outcome === "applied") {
        result.applied.push(run.target);
        if (got.problem) problems.push(got.problem);
      } else {
        log(`${run.target}: apply failed`);
        result.failed.push(run.target);
      }
    }
  }
  if (recordPath && byApply) writeRecord(recordPath, decision, result);
  if (waiting) {
    result.exitCode = 3;
    return;
  }
  if (result.failed.length > 0) {
    result.exitCode = 1;
    return;
  }
  if (problems.length > 0) {
    for (const p of problems) log(p);
    result.exitCode = 1;
    return;
  }
  if (!byApply) {
    const after = runHooks(ctx, "after-apply", decision.hooks?.["after-apply"], runs, planned, decision.digest);
    if (after.failed) failed(ctx, `wave ${k} (${wave.name}) applied, and then a hook after the apply failed`);
  }
  if (recordPath && result.hooks.length > 0) writeRecord(recordPath, decision, result);
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
