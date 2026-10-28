/**
 * The op-runtime seam (#2121, epic #2114).
 *
 * An Op is a convergent verb; *where* it runs is a separate question from
 * *what* it does. This module states that question once, as a provider
 * contract, so `chant run` has one dispatch path instead of a branch per
 * runtime. Core ships the `local` provider (./runtimes/local.ts) and never
 * imports a hosting lexicon; a lexicon that hosts runs implements
 * {@link OpRuntimeProvider} and hangs it off `LexiconPlugin.opRuntime`, where
 * `chant run <op> --on <lexicon>` finds it.
 *
 * The record shapes below are the run ledger's (#2118): what a run wrote to
 * `<env>/runs__<op>.jsonl` is what a provider's `status` and `log` read back,
 * so a run's outcome survives the process that produced it. A provider with no
 * ledger behind it (a hosting lexicon reporting a live run) fills the same
 * shape from whatever it does know.
 */

import type { OpConfig } from "./types";
import type { StepRecord, OpRunResult } from "./local-executor";
import type { WaitingPoint } from "./steward-points";
import type { GateResolutionRecord } from "../lifecycle/gate-ledger";
import type { RunOrigin } from "../lifecycle/release-ledger";
import { NEXT_RELEASE } from "../release-floors";
import type { CapabilityTraceSpan } from "../otlp";
import type { RunComponentsOptions, RunComponentsResult } from "../components/cli-support";

/**
 * How a run ended, or that it has not. `gated` is the state a run reaches when
 * a gate has no recorded resolution — a fact, not a wait (#2119). `waiting` is
 * the state it reaches when an activity asked a decision point that is still
 * open (#2749), a fact of the same kind: a person answers the question, and
 * the next run reads the answer.
 *
 * This is the coarse state a *runtime* reports. The ledger records the
 * executor's own three-state outcome instead ({@link OpRunRecord.status}),
 * which has no `running` or `cancelled`: a record is only written once a run
 * has settled.
 */
export type OpRunState = "running" | "completed" | "failed" | "gated" | "waiting" | "cancelled";

/** Map a settled run's ledger status onto the coarser runtime state. */
export function runStateOf(status: OpRunRecord["status"]): OpRunState {
  return status === "ok" ? "completed" : status === "gated" ? "gated" : status === "waiting" ? "waiting" : "failed";
}

/** One step's outcome as the run ledger keeps it — `StepRecord` minus the fields only a live renderer needs. */
export interface OpRunStepRecord {
  /** The activity function name, or `gate:<signal>` for a gate step. */
  fn: string;
  status: StepRecord["status"];
  durationMs: number;
  /** The step's `outcomeAttribute` capture, when it declared one. */
  outcome?: { name: string; value: unknown };
  /** Who cleared this gate step and when (#2119), for a gate the run passed. */
  approval?: { gate: string; resolvedBy: string; timestamp: string; url?: string };
  /** The failure message, for `status: "fail"`. */
  error?: string;
  /** Why a gate declined a standing approval that was for another plan (#2300) — see {@link StepRecord.refusal}. */
  refusal?: string;
  /** The open decision point this step asked (#2749), for a step skipped because it is waiting on one. */
  point?: WaitingPoint;
  /** The gate this step's command stopped at (#2779), for a step skipped because of it. */
  gate?: { op: string; gate: string };
  /** The run whose checkpoint supplied this step's output, for a step a resumed run skipped (#3947). */
  resumed?: { run: string; gate: string };
  /** The image a `shellCmd` step ran in (#4015), pinned by digest, for a step that ran in a container. */
  image?: string;
}

/** One phase's steps and the verdict they add up to. */
export interface OpRunPhaseRecord {
  name: string;
  /** `fail` if any step failed, `skipped` if every step was skipped, else `ok`. */
  status: "ok" | "fail" | "skipped";
  /** The phase's wall-clock time, for a phase that ran. Absent on records written before it was kept, and for a phase skipped whole. */
  durationMs?: number;
  steps: OpRunStepRecord[];
}

/**
 * A run's current state, as every runtime reports it.
 *
 * `records` and `result` are populated by a runtime that has the executor's
 * own step records to hand (the local one does, for a run it just executed in
 * this process); a runtime answering from the ledger alone omits them rather
 * than inventing them.
 */
export interface OpRunStatus {
  op: string;
  runId: string;
  state: OpRunState;
  /** ISO-8601 instant the run started. */
  startedAt: string;
  /** ISO-8601 instant the run settled; absent while it is still running. */
  endedAt?: string;
  /** Per-step records, when the runtime has them. */
  records?: StepRecord[];
  /** The executor's own result, when the runtime is executing in this process. */
  result?: OpRunResult;
  /** The gate this run is waiting on, when `state` is `gated`; `op` names the op it is recorded under when that isn't the run's own (#2779). */
  gate?: { name: string; since: string; op?: string };
  /** The open decision point this run is waiting on, when `state` is `waiting` (#2749). */
  point?: WaitingPoint & { since: string };
  /** Free-text detail for a failed run. */
  error?: string;
}

/**
 * One immutable, settled Op run — the run ledger's line
 * (`../lifecycle/run-ledger.ts`), and what `chant run log <op>` prints a row
 * per.
 *
 * This is where a run's outcome lives now that `OpConfig` no longer carries
 * `searchAttributes` for the generated workflow to upsert (#2118). `labels` is
 * copied off the declaration so a reader can filter runs the way it filters
 * declarations; `outcomes` is every `outcomeAttribute` the run captured, later
 * steps winning over earlier ones for a repeated name, exactly as an upsert
 * would have.
 */
export interface OpRunRecord {
  /** Schema version, so an incompatible future shape is detected before being misread. */
  version: 1;
  /** Stable run id — the same string a pending gate fact records for this run. */
  id: string;
  /** The Op's name (`OpConfig.name`). */
  op: string;
  /** The Op's `labels.Env`, or `local` when it declares none. */
  env: string;
  /** ISO-8601 instant the run started. */
  started: string;
  /** ISO-8601 instant the run settled. */
  ended: string;
  /**
   * The executor's three-state outcome. `gated` is neither success nor
   * failure: the run reached a gate nobody has approved, recorded the fact,
   * and stopped (#2119).
   */
  status: "ok" | "fail" | "gated" | "waiting";
  /** The Op's own `labels`, copied at run time. */
  labels: Record<string, string>;
  /** Every `outcomeAttribute` the run captured, name → value. */
  outcomes: Record<string, unknown>;
  /** Per-phase, per-step status, in execution order. */
  phases: OpRunPhaseRecord[];
  /**
   * The gate the run stopped on, for `status: "gated"`. `op` is set when the
   * gate is recorded under another op than the run's (#2779): a step whose
   * command stopped at its own gate, such as `chant workspace upgrade`'s
   * `workspace-upgrade` / `<scope>`.
   */
  gate?: { name: string; since: string; op?: string };
  /**
   * The open decision point the run stopped on, for `status: "waiting"`
   * (#2749): the answer record's id, the point, its state then, and when the
   * run stopped. `points --open` and hud read the question itself.
   */
  point?: WaitingPoint & { since: string };
  /** The steward whose turn the run was, when a steward ran it (#2749). */
  steward?: string;
  /**
   * The gate this run resumed at (#3947), the run whose checkpoint it carried
   * on from, and the checkpoint's digest. Absent on a run that started at the
   * first phase.
   */
  resumed?: { gate: string; run: string; checkpoint: string };
  /**
   * The commit the run built from (#4020): the checkout's `HEAD`, else the
   * commit the CI job started for. Gate facts the run writes carry the same
   * commit, so a run and its gate join on it. Absent on a record written
   * before 0.124.28 and when the run knew no commit.
   */
  gitSha?: string;
  /**
   * The CI run this Op ran in (#4020), as a deploy record's `runOrigin` names
   * its run, so the two name a run the same way. `id` is still the Op's own
   * run id. Absent outside CI and on a record written before 0.124.28.
   */
  runOrigin?: RunOrigin;
  /**
   * The workspace run that started this one (#2554, #2524 D17): `chant
   * workspace run`'s id, and the workspace gate it ran under when it named
   * one. The workspace run's own record, under `_members/_workspace/` on
   * `chant/lifecycle`, names this run in turn. Absent on a run nothing in a
   * workspace started, and on a record written before 0.124.47.
   */
  workspaceRun?: { id: string; gate?: string };
  /**
   * The run's statement (#4044): a DSSE envelope over an in-toto statement
   * (`https://intentius.io/chant/op-run/v1`) a runner key signed at the end
   * of the run, naming the run, its commit and the SHA-256 of this record
   * without the statement (`../workspace/trust/op-run-statement.ts`).
   * `chant ci tick` with `ci.green.source: "runs"` counts only a run that
   * carries one. Absent on a run given no runner key, and on a record
   * written before 0.124.28.
   */
  statement?: { payloadType: string; payload: string; signatures: { keyid: string; sig: string }[] };
  /**
   * Why a failed run failed (#4094), for a reader that acts on it without
   * reading the log: a short `code`, a one-line `reason`, the phase that
   * failed and the exit code of the command that failed. `chant ci run`
   * writes it on every failed job, from the job's pull-request report when
   * it wrote one (`not-a-reviewer`, `plan-failed`, `failed` and the other
   * refusals and statuses), else `command-failed`, `setup-failed` or
   * `build-failed`. Optional within contract 1, written by chant
   * {@link OP_RUN_FAILURE_FLOOR} and newer; absent on a run that passed and
   * on a run nothing explained.
   */
  failure?: OpRunFailureReason;
  /**
   * The op wave job this record is for (#4551): one record per `chant run
   * wave` job, under the spec's name as `op`. Optional within contract 1,
   * written by chant {@link OP_WAVE_RUN_RECORD_FLOOR} and newer; absent on
   * every other run.
   */
  wave?: OpRunWave;
}

/** Which op wave job a run record is for, and how it ended (#4551). */
export interface OpRunWave {
  /** The spec's name, as `op` holds it. */
  spec: string;
  /** The wave the job was started for, 1-based. */
  number: number;
  /** That wave's name. */
  name: string;
  /** `wave` for a whole wave, `decide` for a wide wave's deciding job, `share` or `group` for its apply jobs. */
  job: "wave" | "decide" | "share" | "group";
  share?: number;
  group?: string;
  /** The set digest the job decided or applied under. Jobs of one wave join on it. */
  digest?: string;
  /** The job's exit code, as `chant run wave` exited (chant's exit-code table, #4553). */
  exitCode: number;
  /** Set when the apply applied nothing and nothing failed: another run held it, or it stood down for a newer one. */
  outcome?: "held" | "stood-down";
  /**
   * The newer commit an apply stood down for (#4581), when chant found it
   * on the branch itself (the spec's `standDown`). An apply command that
   * wrote `stood-down` names none.
   */
  supersededBy?: { branch: string; commit: string };
  applied: string[];
  failed: string[];
  /** Runs a share job did not apply because their plan moved since the decision. */
  moved: string[];
  /** Runs a failure blocked, each with the run that blocked it. */
  blocked?: Record<string, string>;
  /**
   * Each run target the job applied or tried to apply (#4555): when its
   * apply started, how long it took, and what its capability knew about it
   * (engine facts, and the resources it timed, such as plunge's provider
   * calls and record writes). The same facts are the attributes and child
   * spans of the target's span in the job's trace. Written by the same
   * chant as `wave` itself.
   */
  targets?: Record<string, OpRunWaveTarget>;
  /**
   * Each run the job planned, by target, when its plan carried policy rows
   * or an after-plan hook in the job's process gave rows or files (#4614).
   * Written by chant {@link OP_WAVE_AFTER_PLAN_FLOOR} and newer.
   */
  plans?: Record<string, OpRunWavePlan>;
}

/** One policy check's row for a planned run (#4614): chant's `holds.policy`, or a product's own check. */
export interface OpRunPolicyRow {
  /** Who checked: `ci.policy` for chant's wave hold, else the product's name for its own check. */
  source: string;
  /** `denied` denies the run (an override then counts), `held` holds the wave for a person; `passed` and `warned` change nothing. */
  result: "passed" | "warned" | "denied" | "held";
  /** The ids of the rules that denied, held or warned, sorted. */
  rules: string[];
  reason?: string;
}

/** One planned run of an op wave job (#4614). */
export interface OpRunWavePlan {
  planDigest: string;
  /** The policy rows of its plan: chant's `holds.policy` first, then each after-plan hook's. */
  policy?: OpRunPolicyRow[];
  /** Files an after-plan hook wrote for the run, relative to the job's directory, such as a product's plan view. */
  files?: string[];
}

/** The first chant that runs an after-plan hook in the wave job's process and writes {@link OpRunWave.plans} (#4614). */
export const OP_WAVE_AFTER_PLAN_FLOOR = NEXT_RELEASE;

/** One run target's apply in an op wave job (#4555). */
export interface OpRunWaveTarget {
  /** When its apply started, ISO-8601. */
  startedAt: string;
  durationMs: number;
  /** Engine facts, as the trace writes them before the product's prefix. */
  attributes?: Record<string, string | number | boolean>;
  /** The pieces the engine timed. */
  spans?: CapabilityTraceSpan[];
}

/** The first chant that writes {@link OpRunRecord.wave}, a run record per op wave job (#4551). */
export const OP_WAVE_RUN_RECORD_FLOOR = NEXT_RELEASE;

/** `value` as an {@link OpRunWave}, or undefined when it is not one, so a reader drops a malformed field and keeps the record. */
export function opRunWaveOf(value: unknown): OpRunWave | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const names = (x: unknown): x is string[] => Array.isArray(x) && x.every((t) => typeof t === "string");
  if (typeof v.spec !== "string" || !Number.isInteger(v.number) || typeof v.name !== "string" || !Number.isInteger(v.exitCode)) return undefined;
  if (v.job !== "wave" && v.job !== "decide" && v.job !== "share" && v.job !== "group") return undefined;
  if (!names(v.applied) || !names(v.failed) || !names(v.moved)) return undefined;
  return v as unknown as OpRunWave;
}

/** Why a run failed, on {@link OpRunRecord.failure} and on the run's `run-settle` event (#4094). */
export interface OpRunFailureReason {
  /** A short code: a pull-request report's refusal or status, or `command-failed`, `setup-failed`, `build-failed`. */
  code: string;
  /** One line a person reads. */
  reason: string;
  /** The phase that failed, when one did. */
  phase?: string;
  /** The exit code of the command that failed, when it exited with one. */
  exitCode?: number;
}

/** The first chant that writes {@link OpRunRecord.failure} and `failure` on `run-settle` (#4094). */
export const OP_RUN_FAILURE_FLOOR = "0.124.30";

/** `value` as an {@link OpRunFailureReason}, or undefined when it is not one, so a reader drops a malformed field and keeps the record. */
export function opRunFailureOf(value: unknown): OpRunFailureReason | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.code !== "string" || v.code === "" || typeof v.reason !== "string") return undefined;
  if (v.phase !== undefined && typeof v.phase !== "string") return undefined;
  if (v.exitCode !== undefined && !Number.isInteger(v.exitCode)) return undefined;
  return {
    code: v.code,
    reason: v.reason,
    ...(typeof v.phase === "string" ? { phase: v.phase } : {}),
    ...(typeof v.exitCode === "number" ? { exitCode: v.exitCode } : {}),
  };
}

/** An {@link OpRunRecord} before the ledger stamps its version and mints an id. */
export type OpRunRecordInput = Omit<OpRunRecord, "version" | "id"> & { id?: string };

/** A started run. `result()` settles with the run's final status. */
export interface OpRunHandle {
  op: string;
  runId: string;
  result(): Promise<OpRunStatus>;
}

/** What a caller hands a runtime when it starts a run. */
export interface OpRunStartOptions {
  /** Build-time parameter bindings, when the caller resolved any. */
  params?: Record<string, unknown>;
  /** Target environment (`--env`). */
  env?: string;
  /**
   * `-p, --profile <name>` (#2124, restored in #2192) — the named connection
   * profile this runtime should target. Only a runtime that has profiles
   * reads it; the local one ignores it, and a runtime that reads it decides
   * for itself what an unknown name means (fountain refuses it rather than
   * falling back to its default).
   */
  profile?: string;
  /** Called once per settled step, so `--progress-json` can stream. */
  progress?: (record: StepRecord) => void;
  /**
   * Where the run's event stream goes (#4041, `--events-json`): one
   * `run-event.schema.json` line at a time, written through the one writer
   * (`createRunEventWriter`). The local runtime writes `runtime: "local"`
   * events (`ci` in a CI job); a hosted runtime writes its own, as fountain
   * writes `runtime: "steward"` ones. A runtime that cannot stream omits it.
   */
  runEvents?: (line: string) => void;
  /** Aborts in-flight work (Ctrl-C). */
  signal?: AbortSignal;
  /**
   * For an Op that declares `workLease` (#2748): the work item this run is
   * for (`--work <id>`) and who holds its lease (`--holder`). The local
   * runtime takes the lease itself; a runtime that declares
   * {@link OpRuntimeProvider.carriesWork} hands both to where the run
   * executes, which takes it there.
   */
  work?: { item?: string; holder?: string };
  /**
   * The id to name this run by, in place of one the runtime mints (#3539).
   * The local runtime uses it as the run record's id, the gate ledger's
   * `runId` and `currentOpRun().runId`. `chant acp` passes fountain's
   * conversation id here, so the record a hosted run writes in the sandbox
   * and the run `chant run status --on fountain` reports carry the same id.
   */
  runId?: string;
  /**
   * Signs the run's record when it settles (#4044), for `chant run <op>
   * --key` or `CHANT_RUNNER_KEY`: the local runtime stores what it returns
   * on the record as `statement`. A runtime that writes no record here
   * ignores it.
   */
  signRecord?: (record: OpRunRecord) => NonNullable<OpRunRecord["statement"]>;
}

/** What a caller hands {@link OpRuntimeProvider.resolveGate} besides the resolution. */
export interface OpGateResolveOptions {
  /**
   * `--env` on `chant run approve` (#3539): the environment the woken run
   * runs in. Omitted, a runtime keeps the environment the gated run had.
   */
  env?: string;
}

/**
 * The contract a runtime implements to host Op runs.
 *
 * `chant run` resolves exactly one provider per invocation — the named
 * lexicon's for `--on <name>`, the built-in `local` one otherwise — and every
 * subcommand calls it. A provider that cannot do something (cancel a
 * foreground run, host components) says so by throwing a message the CLI
 * prints verbatim, or by omitting the optional member.
 */
export interface OpRuntimeProvider {
  /** How the CLI names this runtime in messages, and what `--on` matches. */
  readonly name: string;

  /**
   * Whether `start` carries `opts.work` to where the run executes (#3555),
   * so `chant run <op> --work <id> --on <name>` is allowed. Omitted, a
   * non-local runtime is refused `--work` and `--holder` by name.
   */
  readonly carriesWork?: boolean;

  /** Start a run. Rejects with an actionable Error when it cannot. */
  start(op: OpConfig, opts: OpRunStartOptions): Promise<OpRunHandle>;

  /** The latest run's state, or `undefined` when this runtime has none recorded. */
  status(op: string): Promise<OpRunStatus | undefined>;

  /** Run history, newest first. Empty when nothing is recorded. */
  log(op: string, opts?: { limit?: number }): Promise<OpRunRecord[]>;

  /** Latest state for each of `ops`, keyed by op name. */
  list(ops: OpConfig[]): Promise<Map<string, OpRunStatus | undefined>>;

  /** Cancel the active run. `force` is the CLI's confirmation, already checked. */
  cancel(op: string, opts: { force: boolean }): Promise<void>;

  /**
   * Wake a run whose gate has just been resolved. The ledger write is the
   * fact and `chant approve` owns it; this is the runtime's chance to act on
   * it. Omit when a run re-reads the ledger on its own. `opts.env` is the
   * `--env` the approver named, when they named one.
   */
  resolveGate?(op: string, gate: string, resolution: GateResolutionRecord, opts?: OpGateResolveOptions): Promise<void>;

  /**
   * Host `chant run --components`. Optional: a runtime without it refuses the
   * flag with one line naming itself.
   */
  runComponents?(
    projectPath: string,
    selector: string,
    options: RunComponentsOptions,
  ): Promise<RunComponentsResult>;
}
