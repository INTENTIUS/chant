/**
 * `convergeTick` — the activity a `ConvergeOp`-generated workflow's Converge
 * phase runs (../../composites/converge-op.ts). One call is one tick:
 * observe (shell to `chant lifecycle plan`/`chant components status`, the
 * same CLI surface `reconcilePr`/`lifecycleDiff` already shell to — see
 * ./reconcile.ts, ./lifecycle.ts) -> classify (the pure rule table
 * evaluator, `@intentius/chant/op`'s `evaluatePredicate`, then this
 * activity's own runtime backstop re-classifying each dispatch target's verb
 * class before it runs — see `verbClassAllowedToDispatch` below) -> dispatch
 * within budget (`chant run <op>`, the existing local runner — a gated
 * dispatched Op fails loudly with `LocalGateUnsupportedError`, which is why
 * `TMP014` refuses a destructive dispatch target outright in v1 rather than
 * shipping a "gated destructive dispatch" path that can never actually
 * complete) -> record (one line to the converge ledger,
 * `@intentius/chant/lifecycle/converge-ledger`).
 *
 * Deliberately monolithic, matching `reconcilePr`'s shape (one activity that
 * derives the change set, regenerates, and opens the PR) rather than
 * `ApplyOp`'s Build/Plan/Approve/Apply phase split — a converge tick's
 * "classify against a rule table, then dispatch" step can't be decomposed
 * into separate static Temporal steps, because *which* rules fire is a
 * runtime fact discovered only once live symptoms are read, and Temporal
 * workflow structure has to be fully static at build time. Splitting
 * `Observe` into its own phase (the composite still does, for the `Drift`
 * search attribute and Temporal-UI visibility WatchOp/ApplyOp/ReconcileOp
 * all get) and threading its result into this activity's `args` via a
 * step-output reference (#1290) rather than a search-attribute round-trip is
 * the seam this module *does* use the new dataflow for.
 *
 * `unknown` never remediates: whatever a rule's own predicate says, a tick
 * whose derived symptom is `status: "unknown"` forces every fired `run`
 * action to `report` instead — the honesty requirement is enforced here, at
 * the one place a bad rule table can't route around it, not only trusted to
 * rule authors.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  evaluatePredicate,
  classifyOpVerbClass,
  discoverOps,
  type ConvergeRule,
  type RuleAction,
  type OpVerbClass,
  DEFAULT_FLAP_THRESHOLD,
} from "@intentius/chant/op";
import { deriveSymptoms, type ConvergeSymptom } from "@intentius/chant/lifecycle/symptoms";
import {
  appendConvergeRecord,
  readConvergeLedger,
  consecutiveRuleFires,
  componentVerdicts,
  sanitizeLedgerText,
  type ConvergeRuleOutcome,
  type ConvergeTickRecord,
} from "@intentius/chant/lifecycle/converge-ledger";
import { fetchLifecycle, pushLifecycle } from "@intentius/chant/lifecycle/git";
import type { ChangeSet } from "@intentius/chant/lifecycle/change-set";
import type { ComponentStatusRow } from "@intentius/chant/lifecycle/status";

const execAsync = promisify(exec);

/** A `ConvergeRule<ConvergeSymptom>`, restated with `S = ConvergeSymptom` fixed — the JSON shape `ConvergeOp` bakes into the workflow's `convergeTick` step args. */
export type SerializedConvergeRule = ConvergeRule<ConvergeSymptom>;

export interface ConvergeTickArgs {
  /** Op name (`ConvergeOp`'s own `config.name`) — carried into the ledger record. */
  opName: string;
  env: string;
  /**
   * Authority level for this environment (the issue's dial × verb-class
   * matrix): `"observe"` never dispatches a mutating/destructive op
   * (report-only); `"reconcile"` free-runs a read-only op but never a
   * mutating one — the issue's table answer for `reconcile` × mutating is
   * "open PR", which v1 doesn't implement (epic #1487's onDrift-channel open
   * question), so `reconcile` refuses that dispatch (`TMP014`, build time)
   * rather than silently escalating it to "run directly"; `"apply"` is the
   * only dial that free-runs a mutating op. A destructive op is refused
   * under every dial, `"apply"` included, in v1 — see `TMP014`'s doc on why
   * "destructive + apply + gated" can never actually dispatch.
   */
  dial: "observe" | "reconcile" | "apply";
  /** Max number of `run` dispatches this tick may perform; remaining matched rules are recorded `skipped-budget`. */
  budget: number;
  /** The rule table, in authored order. */
  rules: SerializedConvergeRule[];
  /**
   * `Observe` phase's quick drift signal, threaded in via a step-output
   * reference rather than a search-attribute round-trip (#1290) — a
   * diagnostic cross-check folded into the tick record, not a control input
   * (this activity re-derives its own symptom independently).
   */
  preflightDrift?: boolean;
}

export interface ConvergeTickResult {
  /** The ledger record's tick id (#2027) — what a caller correlates this tick's outcomes, gate facts and remediations against. */
  id: string;
  drifted: boolean;
  remediated: number;
  reported: number;
  skippedBudget: number;
  skippedFlap: number;
  unobserved: number;
  adopted: number;
  /** Rules whose dispatch hit a gate this tick (#1485) — see `ConvergeRuleOutcome.action`'s doc. */
  gated: number;
  /** The one human-readable summary line this tick produced. */
  log: string;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Cap a subprocess failure's raw output to one sanitized line — a ledger
 * record (`converge-ledger.ts`'s `appendConvergeRecord`) is one line of JSON,
 * and a multi-line/oversized `stderr` folded straight into `outcome.reason`
 * would break that. Not a fix for the ledger-durability bug (#1936,
 * `writeBlobToPath`'s corruption under concurrent writes — fixed at the root
 * in a separate PR); this only keeps one dispatch failure's own message from
 * corrupting the line it's written into.
 *
 * The rule now lives next to the record it protects (`sanitizeLedgerText`,
 * #2027), since a component verdict's `detail` needs the same cap; this stays
 * as the dispatch path's name for it.
 */
export const sanitizeOneLine = sanitizeLedgerText;

/** Run `chant lifecycle plan <env> --live --json` and parse its `ChangeSet`. */
async function observeChangeSet(env: string, signal?: AbortSignal): Promise<ChangeSet> {
  const { stdout } = await execAsync(`chant lifecycle plan ${shellQuote(env)} --live --json`, { signal });
  return JSON.parse(stdout) as ChangeSet;
}

/** Run `chant components status <env> --live --json` and parse its rows. */
async function observeStatusRows(env: string, signal?: AbortSignal): Promise<ComponentStatusRow[]> {
  const { stdout } = await execAsync(`chant components status ${shellQuote(env)} --live --json`, { signal });
  const parsed = JSON.parse(stdout) as ComponentStatusRow[] | { rows: ComponentStatusRow[] };
  return Array.isArray(parsed) ? parsed : parsed.rows;
}

/**
 * The local executor's own gate-rejection message (`../../../../../packages/
 * core/src/op/local-executor.ts`'s `LocalGateUnsupportedError`), stable and
 * well-known — `dispatchOp` matches it below to tell "hit a gate" apart from
 * every other dispatch failure, the same way `ensureSearchAttributes`
 * elsewhere in this codebase matches a known error string rather than
 * threading a typed error code through a subprocess boundary. `chant run`
 * itself never gains a distinct JSON field or exit code for this in v1 —
 * the message is the one contract, and it's the same message a human sees
 * running the dispatch by hand.
 */
const GATE_UNSUPPORTED_PATTERN = /gate "([^"]+)" is not supported in local mode/;

/** Gate-as-fact detection for a dispatch's raw failure output (#1485) — pure, unit-tested directly rather than only through `dispatchOp`'s subprocess plumbing. `undefined` when the failure wasn't a gate rejection. */
export function classifyDispatchFailure(raw: string): { gateName: string } | undefined {
  const match = raw.match(GATE_UNSUPPORTED_PATTERN);
  return match ? { gateName: match[1] } : undefined;
}

/**
 * Dispatch one matched `run` action via the existing local runner (`chant
 * run <op>`). A gated target Op is gate-as-fact (#1485): its own local
 * executor still refuses to run it (`LocalGateUnsupportedError`, unchanged —
 * see `../../../../../packages/core/src/lifecycle/gate-ledger.ts`'s doc on
 * why that's still true in v1), but this tick no longer treats that refusal
 * as an ordinary dispatch failure. `gateName` set on the return value is
 * what `convergeTick` below turns into a `"gated"` outcome instead of a
 * `"reported"` one — a terminal, durable, non-blocking fact rather than an
 * error the operator retries every tick until a human notices the log.
 */
async function dispatchOp(
  opName: string,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; error: string; gateName?: string }> {
  try {
    await execAsync(`chant run ${shellQuote(opName)}`, { signal });
    return { ok: true };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const raw = e.stderr ?? e.message ?? String(err);
    const gate = classifyDispatchFailure(raw);
    return { ok: false, error: sanitizeOneLine(raw), gateName: gate?.gateName };
  }
}

/**
 * Verb class allowed to free-run for a given dial — the coarse first-pass
 * gate: `"observe"` never dispatches anything (report only), `"reconcile"`
 * and `"apply"` both allow *some* dispatch. Which verb classes each of those
 * two actually permits is `TMP014`'s job at build time
 * (`../../lint/post-synth/tmp014-converge-rule-refusals.ts`) and
 * {@link verbClassAllowedToDispatch}'s job as this tick's own runtime
 * backstop, below.
 */
function dialAllowsDispatch(dial: ConvergeTickArgs["dial"]): boolean {
  return dial === "reconcile" || dial === "apply";
}

/**
 * Runtime backstop for issue #1484's Autonomy table (pre-merge review of
 * #1954): `TMP014` already refuses, at build time, a rule table shaped to
 * reach this point with a mutating dispatch outside `"apply"` or any
 * destructive dispatch at all. This is the defense-in-depth check for a rule
 * table that reached `convergeTick` without going through that build — the
 * same "not authored through the checked path" concern
 * `isWellFormedPredicate` already guards for a hand-assembled predicate (see
 * `../../../../packages/core/src/op/converge-rule.ts`'s doc). Fail-closed:
 * an unclassifiable target (`verbClass === undefined`, e.g. the target op
 * couldn't be discovered/read) is never treated as safe to free-run — same
 * fail-closed stance `classifyOpVerbClass` itself takes for an unrecognized
 * activity `fn`.
 */
export function verbClassAllowedToDispatch(dial: ConvergeTickArgs["dial"], verbClass: OpVerbClass | undefined): boolean {
  const effective = verbClass ?? "mutating";
  if (effective === "read-only") return true;
  if (effective === "mutating") return dial === "apply";
  return false; // destructive: refused at runtime, unconditionally — see TMP014's doc on why the gate can never actually run.
}

/**
 * Apply {@link verbClassAllowedToDispatch} to one planned "ran" outcome,
 * downgrading it to "reported" (never silently dropped, never silently run)
 * when the dial/verb-class pairing isn't one the tick may actually free-run.
 * Pure — the impure part (discovering and classifying the target op) is
 * {@link classifyDispatchTarget}, called by `convergeTick` before this.
 */
export function enforceVerbClassAtDispatch(
  outcome: ConvergeRuleOutcome,
  dial: ConvergeTickArgs["dial"],
  verbClass: OpVerbClass | undefined,
): ConvergeRuleOutcome {
  if (outcome.action !== "ran") return outcome;
  if (verbClassAllowedToDispatch(dial, verbClass)) return outcome;
  return {
    ...outcome,
    action: "reported",
    reason:
      `runtime backstop: dial "${dial}" does not permit dispatching "${outcome.op}" ` +
      `(${verbClass ?? "unclassifiable — treated as mutating, fail-closed"}) — TMP014 should already refuse ` +
      `this at build; reporting instead of risking a silent authority escalation`,
  };
}

/** Discover and classify a dispatch target's own verb class. Never throws: an op that can't be discovered/read classifies as `undefined` (fail-closed via {@link verbClassAllowedToDispatch}), not silently as `"read-only"`. */
async function classifyDispatchTarget(opName: string): Promise<OpVerbClass | undefined> {
  try {
    const { ops } = await discoverOps();
    const target = ops.get(opName);
    return target ? classifyOpVerbClass(target.config) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The pure planning core: given a symptom, a rule table, prior-tick fire
 * history, the dial, and the remaining budget, decide what each rule does
 * this tick. Exported and unit-tested directly — the activity function
 * around it is the thin I/O shell (gather inputs, execute the plan, append
 * the ledger record), matching `reconcilePr`'s split between its pure
 * `reconcileSummary`/`entriesFromPlan` and its I/O body.
 */
export interface ConvergeTickPlan {
  firedRuleIds: string[];
  outcomes: ConvergeRuleOutcome[];
}

export function planConvergeTick(
  symptom: ConvergeSymptom,
  rules: SerializedConvergeRule[],
  priorRecords: ConvergeTickRecord[],
  dial: ConvergeTickArgs["dial"],
  budget: number,
): ConvergeTickPlan {
  const firedRuleIds: string[] = [];
  const outcomes: ConvergeRuleOutcome[] = [];
  let dispatched = 0;

  for (const rule of rules) {
    if (!evaluatePredicate(rule.when, symptom)) continue;
    firedRuleIds.push(rule.id);

    const threshold = rule.flapThreshold ?? DEFAULT_FLAP_THRESHOLD;
    const consecutive = consecutiveRuleFires(priorRecords, rule.id);
    if (consecutive >= threshold) {
      outcomes.push({
        ruleId: rule.id,
        action: "skipped-flap",
        reason: `fired ${consecutive + 1} consecutive ticks without clearing (threshold ${threshold}) — escalated to report`,
      });
      continue;
    }

    const action: RuleAction = rule.then;

    // `unknown` never remediates, regardless of what the rule says.
    if (symptom.status === "unknown" && action.kind === "run") {
      outcomes.push({
        ruleId: rule.id,
        action: "reported",
        reason: `symptom is unknown (${symptom.unobservedReasons.join(", ") || "unobserved"}) — unknown never remediates`,
      });
      continue;
    }

    if (action.kind === "report") {
      outcomes.push({ ruleId: rule.id, action: "reported", reason: action.reason });
      continue;
    }

    // action.kind === "run"
    if (!dialAllowsDispatch(dial)) {
      outcomes.push({ ruleId: rule.id, action: "reported", reason: `dial "${dial}" does not permit dispatch — report only`, op: action.op });
      continue;
    }
    if (dispatched >= budget) {
      outcomes.push({ ruleId: rule.id, action: "skipped-budget", op: action.op });
      continue;
    }
    dispatched++;
    outcomes.push({ ruleId: rule.id, action: "ran", op: action.op });
  }

  return { firedRuleIds, outcomes };
}

function summarizeOutcomes(outcomes: ConvergeRuleOutcome[]) {
  return {
    remediated: outcomes.filter((o) => o.action === "ran").length,
    reported: outcomes.filter((o) => o.action === "reported").length,
    skippedBudget: outcomes.filter((o) => o.action === "skipped-budget").length,
    skippedFlap: outcomes.filter((o) => o.action === "skipped-flap").length,
    gated: outcomes.filter((o) => o.action === "gated").length,
  };
}

function renderLog(env: string, s: ConvergeSymptom, counts: ReturnType<typeof summarizeOutcomes>): string {
  return (
    `converge(${env}): drifted=${s.updateCount + s.deleteCount} remediated=${counts.remediated} ` +
    `reported=${counts.reported} skipped-budget=${counts.skippedBudget} skipped-flap=${counts.skippedFlap} ` +
    `gated=${counts.gated} unobserved=${s.unobservedCount} adopted=${s.adoptCount}`
  );
}

export async function convergeTick(args: ConvergeTickArgs, signal?: AbortSignal): Promise<ConvergeTickResult> {
  await fetchLifecycle().catch(() => undefined);

  const [cs, statusRows, ledger] = await Promise.all([
    observeChangeSet(args.env, signal),
    observeStatusRows(args.env, signal),
    readConvergeLedger(args.env),
  ]);

  const symptom = deriveSymptoms(args.env, cs, statusRows);
  const plan = planConvergeTick(symptom, args.rules, ledger.records, args.dial, args.budget);

  // Execute: only "ran" outcomes cause a subprocess dispatch. Before that
  // dispatch, the runtime backstop (Finding A, #1954 pre-merge review)
  // re-classifies the target and downgrades to "reported" if this dial/verb
  // class pairing was never supposed to reach dispatch — TMP014 (build time)
  // is the primary defense; this is what catches a rule table that reached
  // `convergeTick` without going through it.
  for (const outcome of plan.outcomes) {
    if (outcome.action !== "ran" || !outcome.op) continue;

    const verbClass = await classifyDispatchTarget(outcome.op);
    const backstopped = enforceVerbClassAtDispatch(outcome, args.dial, verbClass);
    outcome.action = backstopped.action;
    outcome.reason = backstopped.reason;
    if (outcome.action !== "ran") continue;

    const result = await dispatchOp(outcome.op, signal);
    if (!result.ok && result.gateName) {
      // Gate-as-fact (#1485): a terminal, durable, non-blocking fact — not
      // an ordinary dispatch failure the operator keeps retrying. See
      // ../../../../../packages/core/src/lifecycle/gate-ledger.ts's doc for
      // how this resolves (`chant approve`, or a merged PR).
      outcome.action = "gated";
      outcome.gateName = result.gateName;
      outcome.reason =
        `dispatch of "${outcome.op}" hit gate "${result.gateName}" — recorded as a pending fact, not retried; ` +
        `resolve with \`chant approve ${outcome.op} ${result.gateName}\` or a merged PR`;
    } else if (!result.ok) {
      outcome.action = "reported";
      outcome.reason = `dispatch of "${outcome.op}" failed: ${result.error}`;
    }
  }

  const counts = summarizeOutcomes(plan.outcomes);
  const log = renderLog(args.env, symptom, counts);
  const timestamp = new Date().toISOString();

  const { record } = await appendConvergeRecord({
    op: args.opName,
    env: args.env,
    timestamp,
    firedRuleIds: plan.firedRuleIds,
    outcomes: plan.outcomes,
    // #2027: the per-component verdicts this tick already observed, kept
    // instead of discarded once `summary`'s counts were derived from them.
    components: componentVerdicts(statusRows),
    summary: {
      drifted: symptom.updateCount + symptom.deleteCount,
      remediated: counts.remediated,
      reported: counts.reported,
      skippedBudget: counts.skippedBudget,
      skippedFlap: counts.skippedFlap,
      gated: counts.gated,
      unobserved: symptom.unobservedCount,
      adopted: symptom.adoptCount,
    },
    log,
  });
  await pushLifecycle().catch(() => undefined);

  return {
    id: record.id,
    drifted: symptom.status === "drifted",
    remediated: record.summary.remediated,
    reported: record.summary.reported,
    skippedBudget: record.summary.skippedBudget,
    skippedFlap: record.summary.skippedFlap,
    gated: record.summary.gated ?? 0,
    unobserved: record.summary.unobserved,
    adopted: record.summary.adopted,
    log: record.log,
  };
}
