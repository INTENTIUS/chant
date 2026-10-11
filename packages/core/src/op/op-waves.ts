/**
 * Gated waves of Op runs (#3679): a pipeline that applies one Op per
 * environment, or per target in a set, in order, each wave behind one gate.
 *
 * A product built on chant that applies a migration to dev, then staging, then
 * prod, or the same change to every tenant database of an environment, used to
 * render that ordering itself, once per forge, and compute each wave's set
 * digest itself. This module holds the forge-neutral part: the spec, the jobs
 * it becomes and the commands they run. Each forge lexicon (github, gitlab,
 * forgejo) renders these jobs with its own transport, so the three cannot
 * disagree about order or commands. `./op-waves-run.ts` is what the jobs run.
 *
 * ## Jobs
 *
 * A wave is one job, `wave-<k>-<name>`, running `chant run wave --spec <file>
 * --wave <k>`: plan every run, decide the wave's gate, apply. A wide wave
 * (`shares` > 1) is a deciding job that plans every run and decides the gate,
 * plus `shares` jobs that each apply a slice of the runs and refuse a run
 * whose plan moved since the decision. Each wave's jobs need the previous
 * wave's last jobs, so a wave that waits (exit 3) or fails stops every later
 * wave.
 *
 * ## The gate
 *
 * Wave k waits on `waveGateName(<gate>, k)`, recorded under the spec's name,
 * bound to {@link waveSetDigest} over its runs' plan digests (`../gated-waves.ts`,
 * the same digest a component fan-out's wave binds). Whether it waits at all
 * is the wave's gate policy, read from the base commit's copy of the spec
 * file, so a change cannot loosen the rule that gates its own merge.
 *
 * So is which approvals count (#3684), the wave's `approval`: `ledger` (any
 * `chant approve` of the digest), `sealed` (only one whose seal verifies
 * against the signers file at base) or `pr-review` (also the merged pull
 * request's review of its head, by a writer other than its author, when the
 * head planned the same digest). See `./gate-review.ts`.
 *
 * ## Spent approvals (#3784)
 *
 * With `approvals: { spend: true }` (read at base, like the policy), a wave
 * records each approval it applies under in `_gates/<name>/applied.jsonl` on
 * `chant/lifecycle`, as terragucci's wave gate does, and that approval is
 * spent: the same digest needs a new approval to apply again.
 *
 * ## Wave-level commands and hooks (#3762)
 *
 * A product whose tool plans a whole wave in one call (Terragrunt's `run
 * --all`, an apply by rows) gives `planWave` and `applyWave` in place of the
 * per-run `plan` and `apply`: one call plans every run and lists each run's
 * plan, and the wave's digest and gate come from that list as from per-run
 * plans. Stage hooks (`hooks`) run commands before and after the plan and the
 * apply; like the policy they are read from the spec at the base commit, and
 * one whose `onFailure` is `approve` holds the wave for an approval whatever
 * its policy says.
 */

import type { OpEnvironment, OpSetupStep } from "../lexicon";
import { notifyConfigProblem, type NotifyConfig } from "../notify";

/**
 * The variables a wave job reads its notify secrets from, for the lexicons
 * that generate wave pipelines. Re-exported here because a lexicon's source
 * in this repository cannot import `@intentius/chant/notify`: under any
 * loader that entry resolves its `import` condition to the compiled
 * `dist/notify.js` (#3803), which only a packed release carries.
 */
export { notifyVariables } from "../notify";

/** When a wave waits for an approval. */
export type OpWaveGatePolicy =
  /** Whenever the wave changes something. */
  | "always"
  /** When a run's plan says it is destructive. */
  | "on-destructive"
  /** Never: only review and branch protection stand in front of the wave. */
  | "never";

export const OP_WAVE_GATE_POLICIES: readonly OpWaveGatePolicy[] = ["always", "on-destructive", "never"];

/** Which approvals of a gate's digest count (#3684). See `./gate-review.ts`. */
export type GateApprovalSource =
  /** Any resolution on `chant/lifecycle` that names the digest. */
  | "ledger"
  /** As `ledger`, and the merged pull request's review of its head, by a writer other than its author. */
  | "pr-review"
  /** Only a resolution sealed by a key the signers file at base lists for its approver. */
  | "sealed";

export const GATE_APPROVAL_SOURCES: readonly GateApprovalSource[] = ["ledger", "pr-review", "sealed"];

/** What a failing hook does: fail the wave, or hold it for an approval of its set digest. */
export type OpWaveHookFailure = "fail" | "approve";

export const OP_WAVE_HOOK_FAILURES: readonly OpWaveHookFailure[] = ["fail", "approve"];

/** One stage hook (#3762): a command run before or after a wave's plan or apply. */
export interface OpWaveHook {
  /** The hook's name in the log and the result. Default: its command. */
  name?: string;
  /**
   * Argv template. `{op}`, `{wave}` and `{runs}` (the runs file, see
   * `opWaveRunsPath`) are filled in; a `perRun` hook also gets `{target}`
   * and, once the run is planned, `{plan}`.
   */
  command: string[];
  /** Default `"fail"`. `"approve"` holds the wave for an approval of its set digest whatever its policy says. Not allowed after apply. */
  onFailure?: OpWaveHookFailure;
  /** Run once per run of the wave, rather than once for the wave. */
  perRun?: boolean;
}

/** The stages a hook runs around. */
export type OpWaveHookStage = "plan" | "apply";

/** When a hook runs. */
export type OpWaveHookMoment = "before-plan" | "after-plan" | "before-apply" | "after-apply";

export const OP_WAVE_HOOK_MOMENTS: readonly OpWaveHookMoment[] = ["before-plan", "after-plan", "before-apply", "after-apply"];

/**
 * Who runs the `before.apply` and `after.apply` hooks (#3804). `chant`: the
 * wave job, around the apply command. `apply`: the apply command itself,
 * under its own lock, through `runOpWaveApplyHooks` and the file named by
 * `CHANT_HOOKS`; it writes the outcomes back to `CHANT_HOOKS_RESULT`.
 */
export type OpWaveApplyHooksRunner = "chant" | "apply";

export const OP_WAVE_APPLY_HOOKS_RUNNERS: readonly OpWaveApplyHooksRunner[] = ["chant", "apply"];

/** Stage hooks (#3762), read from the spec at the base commit like the gate policy. */
export interface OpWaveHooks {
  before?: { plan?: OpWaveHook[]; apply?: OpWaveHook[] };
  after?: { plan?: OpWaveHook[]; apply?: OpWaveHook[] };
  /** Who runs the apply-stage hooks (#3804). Default `{ runBy: "chant" }`. A wave's own setting wins over the spec's. */
  apply?: { runBy?: OpWaveApplyHooksRunner };
}

/** One Op run in a wave: an Op applied to one target (an environment, a database, a tenant). */
export interface OpWaveRun {
  /** What the run applies to. Unique within its wave; it names the run in the set digest. */
  target: string;
  /** The Op to run. Default: the spec's `op`. */
  op?: string;
}

/** One wave: runs that apply together, behind one gate. */
export interface OpWave {
  /** The wave's name, usually its environment. Lowercase letters, digits, `-` and `_`. */
  name: string;
  runs: OpWaveRun[];
  /**
   * When the wave waits. Default `"always"`. The runner reads this from the
   * spec file at the base commit, never from the change being applied.
   */
  gate?: OpWaveGatePolicy;
  /**
   * Which approvals of the wave's digest count (#3684). Default `"ledger"`.
   * Like `gate`, the runner reads it from the spec file at the base commit.
   */
  approval?: GateApprovalSource;
  /**
   * Split the wave into a deciding job and this many share jobs, each
   * applying a slice of the runs. Default 1: one job plans, decides and
   * applies.
   */
  shares?: number;
  /** The forge deployment environment the wave's jobs run in (GitHub and GitLab; Forgejo has none). */
  environment?: OpEnvironment;
  /** Variables for this wave's jobs alone. */
  variables?: Record<string, string>;
  /** Steps this wave's jobs run after the checkout, as `ScheduledOpSpec.setup`. */
  setup?: OpSetupStep[];
  /** This wave's stage hooks (#3762), run after the spec's own. Read at the base commit. */
  hooks?: OpWaveHooks;
}

/**
 * An ordered list of waves of Op runs, as a pipeline and as the file its jobs
 * read. Commands are argv templates; each `{op}`, `{target}`, `{wave}` and
 * `{plan}` is replaced per run.
 */
export interface OpWavesSpec {
  /** The pipeline's name, and the op the wave gates are recorded under (`chant approve <name> <gate>-wave-<k>`). */
  name: string;
  /** The Op a run runs when it names none. */
  op: string;
  /** The base gate name. Default: `name`. */
  gate?: string;
  /** Branches whose pushes run the waves. Default `["main"]`. */
  branches?: string[];
  /**
   * The commit the gate policy is read from. Default `HEAD^1`, the first
   * parent: on a merge or squash onto the branch, the branch before the change.
   */
  base?: string;
  /**
   * Plan one run and write its plan file to `{plan}`: JSON `{ "planDigest":
   * string, "destructive"?: boolean, "empty"?: boolean }`. `destructive` is
   * what `on-destructive` waits on; a wave whose runs are all `empty` never
   * waits. Give this or `planWave`.
   */
  plan?: string[];
  /** Apply one run whose plan is at `{plan}`. Default `chant run {op} --env {target}`. */
  apply?: string[];
  /**
   * Plan every run of a wave in one call (#3762), in place of `plan`. `{runs}`
   * is a file chant writes, `{ "wave", "number", "runs": [{ "target", "op" }] }`;
   * the command writes `{plans}`: `{ "runs": [{ "target", "planDigest",
   * "destructive"?, "empty"? }] }` (or the array alone), one entry per run.
   */
  planWave?: string[];
  /**
   * Apply a wave's approved set in one call (#3762), in place of `apply`.
   * `{runs}` lists the runs to apply with the plan digest each was approved
   * at; `{plans}` is the wave plan's file. A non-zero exit fails every run in
   * the set.
   */
  applyWave?: string[];
  /** Stage hooks for every wave (#3762), run before each wave's own. Read at the base commit. */
  hooks?: OpWaveHooks;
  /** What happens to an approval once a wave applies under it (#3784). Read at the base commit. */
  approvals?: OpWavesApprovals;
  waves: OpWave[];
  /**
   * A scheduled job that starts again a wave job whose approval has arrived
   * (#3683): it runs `chant run resume --op <name>`, which re-runs the
   * GitHub run, retries the GitLab job or dispatches the Forgejo workflow.
   * It approves nothing. Absent, no such job is rendered and an approval is
   * followed by `chant approve --resume` or a re-run by hand.
   */
  resume?: OpWavesResume;
  /**
   * Tell people when a wave waits for an approval, a share job refuses a run
   * whose plan moved, or a wave fails (#3761): the environment variables
   * holding a Slack or Teams incoming webhook's URL, or a generic webhook's
   * URL and the key its `chant.notify/v1` events are signed with. A failed
   * delivery is logged and never changes the job's exit code. See
   * `../notify.ts`.
   */
  notify?: NotifyConfig;
}

/** What happens to an approval once a wave applies under it (#3784). */
export interface OpWavesApprovals {
  /**
   * Spend it. Before a wave applies under an approval it records that in
   * `_gates/<name>/applied.jsonl` on `chant/lifecycle`, and from then on the
   * approval counts for nothing: applying the same digest again, by a re-run
   * or a revert and re-merge, waits for a new approval. Default false: an
   * approval of a digest passes that digest as often as it is planned.
   */
  spend?: boolean;
}

/** The scheduled resume job of an Op waves pipeline (#3683). */
export interface OpWavesResume {
  /**
   * Five-field cron, such as `"*\/10 * * * *"`. GitHub and Forgejo put it
   * in the workflow; GitLab runs the job in a pipeline schedule you create,
   * which sets the cron.
   */
  schedule: string;
}

/** The command a resume job runs. */
export function opWavesResumeCommand(spec: Pick<OpWavesSpec, "name">): string[] {
  return ["chant", "run", "resume", "--op", spec.name];
}

/** The default apply command. */
export const OP_WAVE_DEFAULT_APPLY = ["chant", "run", "{op}", "--env", "{target}"];

/** Where the runner keeps a wave's decision; a wide wave's deciding job hands it to its share jobs. */
export function opWaveRecordPath(spec: Pick<OpWavesSpec, "name">, wave: number): string {
  return `.chant/op-waves/${spec.name}/wave-${wave}.json`;
}

/** One generated job. */
export interface OpWaveJob {
  jobName: string;
  /** 1-based wave number. */
  wave: number;
  /** The wave's name. */
  waveName: string;
  /** `wave`: plan, decide and apply. `decide`: plan and decide. `share`: apply one slice. */
  kind: "wave" | "decide" | "share";
  /** 1-based, on a share job. */
  share?: number;
  /** Jobs this one waits on. */
  needs: string[];
  /** The job's command, as argv. */
  command: string[];
  /** On a share job: the decision record to download. On a deciding job: the one to upload. */
  record?: string;
}

const NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** Refuse a spec no job could run, naming what is wrong. */
export function assertOpWavesSpec(spec: OpWavesSpec): void {
  const where = `Op waves "${spec.name}"`;
  if (!NAME.test(spec.name)) throw new Error(`${where}: the name must be lowercase letters, digits, "-" and "_"`);
  if (!spec.op) throw new Error(`${where} names no \`op\`. Name the Op a run runs when it names none.`);
  if (spec.plan !== undefined && spec.planWave !== undefined) {
    throw new Error(`${where} has both \`plan\` and \`planWave\`. A wave is planned one run at a time or all at once; give one.`);
  }
  if (spec.apply !== undefined && spec.applyWave !== undefined) {
    throw new Error(`${where} has both \`apply\` and \`applyWave\`. A wave is applied one run at a time or all at once; give one.`);
  }
  if (spec.planWave !== undefined) {
    assertArgv(where, "planWave", spec.planWave);
    if (!spec.planWave.some((part) => part.includes("{plans}"))) {
      throw new Error(`${where}: the \`planWave\` command never names {plans}, the file it writes each run's plan digest to.`);
    }
  } else {
    if (!Array.isArray(spec.plan) || spec.plan.length === 0) {
      throw new Error(`${where} has no \`plan\` command. Each wave plans its runs to bind its gate to their plan digests; give \`plan\` or \`planWave\`.`);
    }
    assertArgv(where, "plan", spec.plan);
    if (!spec.plan.some((part) => part.includes("{plan}"))) {
      throw new Error(`${where}: the \`plan\` command never names {plan}, the file it writes the plan digest to.`);
    }
  }
  if (spec.apply !== undefined) assertArgv(where, "apply", spec.apply);
  if (spec.applyWave !== undefined) {
    assertArgv(where, "applyWave", spec.applyWave);
    if (!spec.applyWave.some((part) => part.includes("{runs}"))) {
      throw new Error(`${where}: the \`applyWave\` command never names {runs}, the file listing the approved runs it applies.`);
    }
  }
  assertOpWaveHooks(where, spec.hooks);
  if (spec.waves.length === 0) throw new Error(`${where} has no waves.`);
  if (spec.resume !== undefined && (typeof spec.resume.schedule !== "string" || spec.resume.schedule.trim().split(/\s+/).length !== 5)) {
    throw new Error(`${where}: resume.schedule must be a five-field cron expression, such as "*/10 * * * *".`);
  }
  if (spec.approvals !== undefined) {
    const a = spec.approvals as unknown;
    if (a === null || typeof a !== "object" || Array.isArray(a)) throw new Error(`${where}: \`approvals\` must be { "spend"?: true | false }.`);
    for (const [key, value] of Object.entries(a as Record<string, unknown>)) {
      if (key !== "spend") throw new Error(`${where}: approvals.${key} is not a setting; the one there is approvals.spend.`);
      if (typeof value !== "boolean") throw new Error(`${where}: approvals.spend must be true or false.`);
    }
  }
  if (spec.notify !== undefined) {
    const problem = notifyConfigProblem(spec.notify, "notify");
    if (problem) throw new Error(`${where}: ${problem}`);
  }
  const names = new Set<string>();
  for (const wave of spec.waves) {
    if (!NAME.test(wave.name)) {
      throw new Error(`${where}: wave "${wave.name}" must be named with lowercase letters, digits, "-" and "_"`);
    }
    if (names.has(wave.name)) throw new Error(`${where} names wave "${wave.name}" twice.`);
    names.add(wave.name);
    if (wave.gate !== undefined && !OP_WAVE_GATE_POLICIES.includes(wave.gate)) {
      throw new Error(`${where}: wave "${wave.name}" has gate "${wave.gate}"; use ${OP_WAVE_GATE_POLICIES.join(", ")}.`);
    }
    if (wave.approval !== undefined && !GATE_APPROVAL_SOURCES.includes(wave.approval)) {
      throw new Error(`${where}: wave "${wave.name}" has approval "${wave.approval}"; use ${GATE_APPROVAL_SOURCES.join(", ")}.`);
    }
    assertOpWaveHooks(`${where}, wave "${wave.name}"`, wave.hooks);
    if (wave.runs.length === 0) throw new Error(`${where}: wave "${wave.name}" has no runs.`);
    const targets = new Set<string>();
    for (const run of wave.runs) {
      if (!run.target) throw new Error(`${where}: wave "${wave.name}" has a run with no target.`);
      if (targets.has(run.target)) throw new Error(`${where}: wave "${wave.name}" names target "${run.target}" twice.`);
      targets.add(run.target);
    }
    const shares = wave.shares ?? 1;
    if (!Number.isInteger(shares) || shares < 1) {
      throw new Error(`${where}: wave "${wave.name}" has shares ${wave.shares}; use a whole number from 1.`);
    }
    if (shares > wave.runs.length) {
      throw new Error(`${where}: wave "${wave.name}" has ${shares} shares for ${wave.runs.length} runs, so a share would apply nothing.`);
    }
  }
}

function assertArgv(where: string, field: string, argv: unknown): void {
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((part) => typeof part === "string") || argv[0] === "") {
    throw new Error(`${where}: \`${field}\` must be a command as argv, a non-empty array of strings.`);
  }
}

/** Refuse hooks no runner could run, naming what is wrong (#3762). */
export function assertOpWaveHooks(where: string, hooks: OpWaveHooks | undefined): void {
  if (hooks === undefined) return;
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) {
    throw new Error(`${where}: \`hooks\` must be { "before"?: { "plan"?, "apply"? }, "after"?: { "plan"?, "apply"? } }.`);
  }
  for (const [side, stages] of Object.entries(hooks as Record<string, unknown>)) {
    if (side === "apply") {
      const runBy = (stages as { runBy?: unknown } | null)?.runBy;
      if (stages === null || typeof stages !== "object" || Array.isArray(stages) || Object.keys(stages).some((key) => key !== "runBy")) {
        throw new Error(`${where}: hooks.apply must be { "runBy"?: "chant" | "apply" }.`);
      }
      if (runBy !== undefined && !OP_WAVE_APPLY_HOOKS_RUNNERS.includes(runBy as OpWaveApplyHooksRunner)) {
        throw new Error(`${where}: hooks.apply.runBy is ${JSON.stringify(runBy)}; use ${OP_WAVE_APPLY_HOOKS_RUNNERS.map((r) => `"${r}"`).join(" or ")}.`);
      }
      continue;
    }
    if (side !== "before" && side !== "after") throw new Error(`${where}: hooks.${side} is not a moment; use hooks.before or hooks.after (or hooks.apply.runBy).`);
    if (stages === null || typeof stages !== "object" || Array.isArray(stages)) throw new Error(`${where}: hooks.${side} must be { "plan"?: [...], "apply"?: [...] }.`);
    for (const [stage, list] of Object.entries(stages as Record<string, unknown>)) {
      const at = `hooks.${side}.${stage}`;
      if (stage !== "plan" && stage !== "apply") throw new Error(`${where}: ${at} is not a stage; a hook runs before or after plan or apply.`);
      if (!Array.isArray(list)) throw new Error(`${where}: ${at} must be a list of hooks.`);
      list.forEach((hook: OpWaveHook, i: number) => {
        const which = `${at}[${i}]${hook && typeof hook === "object" && typeof hook.name === "string" ? ` (${hook.name})` : ""}`;
        if (!hook || typeof hook !== "object") throw new Error(`${where}: ${which} must be { "command": [...], "onFailure"?, "perRun"? }.`);
        assertArgv(where, `${which}.command`, hook.command);
        if (hook.onFailure !== undefined && !OP_WAVE_HOOK_FAILURES.includes(hook.onFailure)) {
          throw new Error(`${where}: ${which} has onFailure "${hook.onFailure}"; use ${OP_WAVE_HOOK_FAILURES.join(" or ")}.`);
        }
        if (hook.onFailure === "approve" && side === "after" && stage === "apply") {
          throw new Error(`${where}: ${which} has onFailure "approve", but after the apply there is nothing left to hold. Use "fail".`);
        }
        if (hook.perRun !== undefined && typeof hook.perRun !== "boolean") throw new Error(`${where}: ${which}.perRun must be true or false.`);
        if (!hook.perRun) {
          const named = hook.command.find((part) => part.includes("{target}") || part.includes("{plan}"));
          if (named) throw new Error(`${where}: ${which} runs once for the wave, so it has no {target} or {plan} ("${named}"). Set "perRun": true, or read the runs from {runs}.`);
        } else if (side === "before" && stage === "plan" && hook.command.some((part) => part.includes("{plan}"))) {
          throw new Error(`${where}: ${which} runs before the plan, so it has no {plan} yet.`);
        }
      });
    }
  }
}

/** The hooks of each moment for wave `name`: the spec's, then the wave's own. */
export function opWaveHooksAt(spec: Pick<OpWavesSpec, "hooks" | "waves">, name: string): Record<OpWaveHookMoment, OpWaveHook[]> {
  const wave = spec.waves.find((w) => w.name === name);
  const at = (hooks: OpWaveHooks | undefined, moment: OpWaveHookMoment): OpWaveHook[] => {
    const [side, stage] = moment.split("-") as ["before" | "after", OpWaveHookStage];
    return hooks?.[side]?.[stage] ?? [];
  };
  return Object.fromEntries(OP_WAVE_HOOK_MOMENTS.map((m) => [m, [...at(spec.hooks, m), ...at(wave?.hooks, m)]])) as Record<OpWaveHookMoment, OpWaveHook[]>;
}

/** Who runs wave `name`'s apply-stage hooks (#3804): the wave's `hooks.apply.runBy`, else the spec's, else `chant`. */
export function opWaveApplyHooksRunBy(spec: Pick<OpWavesSpec, "hooks" | "waves">, name: string): OpWaveApplyHooksRunner {
  const wave = spec.waves.find((w) => w.name === name);
  return wave?.hooks?.apply?.runBy ?? spec.hooks?.apply?.runBy ?? "chant";
}

/**
 * The runs share `share` (1-based) of `shares` applies: the wave's runs sorted
 * by target, cut into contiguous slices whose sizes differ by at most one.
 */
export function opWaveShare<T extends { target: string }>(runs: readonly T[], share: number, shares: number): T[] {
  const sorted = [...runs].sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
  const base = Math.floor(sorted.length / shares);
  const extra = sorted.length % shares;
  const start = (share - 1) * base + Math.min(share - 1, extra);
  const size = base + (share <= extra ? 1 : 0);
  return sorted.slice(start, start + size);
}

/**
 * The jobs of an Op waves pipeline, in order. `specFile` is the spec's path
 * from the job's working directory, which every command names.
 */
export function opWaveJobs(spec: OpWavesSpec, specFile: string): OpWaveJob[] {
  assertOpWavesSpec(spec);
  const jobs: OpWaveJob[] = [];
  let previous: string[] = [];
  spec.waves.forEach((wave, index) => {
    const k = index + 1;
    const command = ["chant", "run", "wave", "--spec", specFile, "--wave", String(k), ...(spec.base ? ["--base", spec.base] : [])];
    const prefix = `wave-${k}-${wave.name}`;
    const shares = wave.shares ?? 1;
    if (shares === 1) {
      jobs.push({ jobName: prefix, wave: k, waveName: wave.name, kind: "wave", needs: previous, command });
      previous = [prefix];
      return;
    }
    const record = opWaveRecordPath(spec, k);
    const decide = `${prefix}-decide`;
    jobs.push({ jobName: decide, wave: k, waveName: wave.name, kind: "decide", needs: previous, command: [...command, "--decide"], record });
    const shareJobs: string[] = [];
    for (let share = 1; share <= shares; share++) {
      const jobName = `${prefix}-share-${share}`;
      shareJobs.push(jobName);
      jobs.push({ jobName, wave: k, waveName: wave.name, kind: "share", share, needs: [decide], command: [...command, "--share", String(share)], record });
    }
    previous = shareJobs;
  });
  return jobs;
}

/** The wave a job belongs to. */
export function opWaveOf(spec: OpWavesSpec, job: Pick<OpWaveJob, "wave">): OpWave {
  return spec.waves[job.wave - 1]!;
}
