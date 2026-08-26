/**
 * `convergeTick` — the activity a `ConvergeOp`-generated workflow's Converge
 * phase runs (../../composites/converge-op.ts). One call is one tick:
 * observe (shell to `chant lifecycle plan`/`chant components status`, the
 * same CLI surface `reconcilePr`/`lifecycleDiff` already shell to — see
 * ./reconcile.ts, ./lifecycle.ts) -> classify (the pure rule table
 * evaluator, `@intentius/chant/op`'s `evaluatePredicate`) -> dispatch within
 * budget (`chant run <op>`, the existing local runner — a gated dispatched
 * Op fails loudly with `LocalGateUnsupportedError`, which is the honest
 * outcome: a destructive/gated remediation cannot free-run out of a
 * one-shot local tick) -> record (one line to the converge ledger,
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
  type ConvergeRule,
  type RuleAction,
  DEFAULT_FLAP_THRESHOLD,
} from "@intentius/chant/op";
import { deriveSymptoms, type ConvergeSymptom } from "@intentius/chant/lifecycle/symptoms";
import {
  appendConvergeRecord,
  readConvergeLedger,
  consecutiveRuleFires,
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
   * (report-only); `"reconcile"` allows mutating ops to run but never a
   * destructive one; `"apply"` allows both, with every destructive op still
   * required (at build time, TMP014) to carry its own gate.
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
  drifted: boolean;
  remediated: number;
  reported: number;
  skippedBudget: number;
  skippedFlap: number;
  unobserved: number;
  adopted: number;
  /** The one human-readable summary line this tick produced. */
  log: string;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

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

/** Dispatch one matched `run` action via the existing local runner (`chant run <op>`). A gated target Op fails loudly — expected, not swallowed. */
async function dispatchOp(opName: string, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await execAsync(`chant run ${shellQuote(opName)}`, { signal });
    return { ok: true };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { ok: false, error: (e.stderr ?? e.message ?? String(err)).trim() };
  }
}

/**
 * Verb class allowed to free-run for a given dial (the issue's Autonomy
 * table's "mutating" row — `"observe"` never runs a mutating op, only
 * reports it). Destructive ops are handled separately below: `TMP014`
 * (build time) already refuses one that isn't gated, so at run time the only
 * remaining dial-based question is whether mutating/destructive dispatch is
 * even in-scope for this environment at all.
 */
function dialAllowsDispatch(dial: ConvergeTickArgs["dial"]): boolean {
  return dial === "reconcile" || dial === "apply";
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
  };
}

function renderLog(env: string, s: ConvergeSymptom, counts: ReturnType<typeof summarizeOutcomes>): string {
  return (
    `converge(${env}): drifted=${s.updateCount + s.deleteCount} remediated=${counts.remediated} ` +
    `reported=${counts.reported} skipped-budget=${counts.skippedBudget} skipped-flap=${counts.skippedFlap} ` +
    `unobserved=${s.unobservedCount} adopted=${s.adoptCount}`
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

  // Execute: only "ran" outcomes cause a subprocess dispatch.
  for (const outcome of plan.outcomes) {
    if (outcome.action !== "ran" || !outcome.op) continue;
    const result = await dispatchOp(outcome.op, signal);
    if (!result.ok) {
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
    summary: {
      drifted: symptom.updateCount + symptom.deleteCount,
      remediated: counts.remediated,
      reported: counts.reported,
      skippedBudget: counts.skippedBudget,
      skippedFlap: counts.skippedFlap,
      unobserved: symptom.unobservedCount,
      adopted: symptom.adoptCount,
    },
    log,
  });
  await pushLifecycle().catch(() => undefined);

  return {
    drifted: symptom.status === "drifted",
    remediated: record.summary.remediated,
    reported: record.summary.reported,
    skippedBudget: record.summary.skippedBudget,
    skippedFlap: record.summary.skippedFlap,
    unobserved: record.summary.unobserved,
    adopted: record.summary.adopted,
    log: record.log,
  };
}
