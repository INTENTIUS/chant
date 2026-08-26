/**
 * ConvergeOp composite (#1484, epic #1487 feature 1) — the executable
 * runbook. Observe, classify against a typed rule table, dispatch to
 * declared ops within a per-tick budget, record, rest. Peer to `WatchOp` /
 * `ReconcileOp` / `ApplyOp` — same `{ op, schedule? }` shape, same local
 * one-shot / Temporal-scheduled duality.
 *
 * Phases: `Observe` (snapshot + a quick live diff, exactly `WatchOp`'s own
 * shape, for the `Drift` search attribute and Temporal-UI visibility) ->
 * `Converge` (one `convergeTick` activity call —
 * ../op/activities/converge.ts — that does classify + dispatch + record;
 * see that module's doc for why this can't be split into further static
 * phases). `Observe`'s drift signal threads into `Converge`'s args via a
 * step-output reference (#1290), not a search-attribute round-trip.
 *
 * @example
 * ```typescript
 * import { ConvergeOp } from "@intentius/chant-lexicon-temporal";
 * import { eq, gt, run, report, when } from "@intentius/chant/op";
 * import type { ConvergeSymptom } from "@intentius/chant/lifecycle/symptoms";
 *
 * export const { op, schedule } = ConvergeOp({
 *   name: "fountain-converge",
 *   env: "staging",
 *   dial: "apply",
 *   schedule: "*\/10 * * * *",
 *   rules: [
 *     when<ConvergeSymptom>(eq("status", "drifted"), run("fountain-apply"), {
 *       id: "drift-apply",
 *       why: "Live config drifted from declared source; re-apply converges it back.",
 *     }),
 *     when<ConvergeSymptom>(gt("adoptCount", 0), report("unowned resources present"), {
 *       id: "adopt-report",
 *       why: "An unowned resource is reported for a human to review — never auto-claimed.",
 *     }),
 *     when<ConvergeSymptom>(eq("status", "unknown"), report("environment could not be fully observed"), {
 *       id: "unknown-report",
 *       why: "unknown never remediates — a partial read is a hole to report, not a guess to act on.",
 *     }),
 *   ],
 * });
 * ```
 *
 * @see #1484, #1487
 */

import { Op, phase, activity, OpResource, isWellFormedPredicate, duplicateRuleIds } from "@intentius/chant/op";
import type { ConvergeRule } from "@intentius/chant/op";
import type { ConvergeSymptom } from "@intentius/chant/lifecycle/symptoms";
import { CONVERGE_SYMPTOM_FIELDS } from "@intentius/chant/lifecycle/symptoms";
import { TemporalSchedule } from "../resources";

function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Authority level for this ConvergeOp's environment — issue #1484's own
 * Autonomy table (dial × verb class):
 *
 * | verb class  | observe     | reconcile        | apply                 |
 * |-------------|-------------|------------------|------------------------|
 * | read-only   | free-run    | free-run         | free-run               |
 * | mutating    | report only | open PR          | run, gated per op      |
 * | destructive | refused     | refused          | always gated           |
 *
 * `ConvergeOp` adds no authority an environment did not already grant.
 * Default `"observe"` — not autonomous by default (issue: "a ConvergeOp in
 * an observe environment is a report generator").
 *
 * **v1 implements a conservative subset of this table**, not the whole
 * thing (pre-merge review of #1954 caught the gap between what the code did
 * and what this table says — this doc now matches the issue, and the code
 * matches this doc):
 *
 * | verb class  | observe     | reconcile                          | apply                              |
 * |-------------|-------------|-------------------------------------|--------------------------------------|
 * | read-only   | free-run    | free-run                            | free-run                             |
 * | mutating    | report only | **refused at build (TMP014)**       | run                                   |
 * | destructive | refused     | refused                              | **refused at build (TMP014), v1**   |
 *
 * - **`reconcile` × mutating is "open PR" in the issue's table — not yet
 *   implemented.** Building that channel (reusing `ReconcileOp`'s
 *   `onDrift: "pull-request" | "issue" | "report"`) is out of v1 scope — see
 *   `../../op/converge-rule.ts`'s `ReportAction` doc and epic #1487's
 *   onDrift-channel open question. Until it exists, a rule that would
 *   dispatch a mutating op under `reconcile` is refused at build
 *   (`TMP014`), not silently escalated to "run directly" the way `apply`
 *   would. A runtime backstop in `convergeTick`
 *   (`../op/activities/converge.ts`) re-checks the same thing at dispatch
 *   time, for a rule table that reached the tick without going through that
 *   build.
 * - **`apply` × destructive is refused outright in v1, gate or not.** The
 *   issue's table says "always gated", but the dispatch executor can't
 *   honor a gate: `dispatchOp` always shells `chant run <op>` without
 *   `--temporal`, and the local executor's pre-flight rejects any gated op
 *   before running a single step (`LocalGateUnsupportedError`) — so
 *   "destructive + apply + gated" reads as a path to dispatch but was a
 *   dead cell: it could never actually succeed. `TMP014` now refuses the
 *   rule instead of shipping a path guaranteed to fail every time it's
 *   exercised. Durable gated dispatch (e.g. a `--temporal` pass-through when
 *   the parent workflow itself runs under Temporal) is #1485's design to
 *   own.
 */
export type ConvergeDial = "observe" | "reconcile" | "apply";

export interface ConvergeOpConfig {
  /** Op name (kebab-case). Used as workflow function name, task queue, schedule id base. */
  name: string;
  /** Environment to converge (e.g. "staging"). */
  env: string;
  /** @default "observe" */
  dial?: ConvergeDial;
  /** Max number of `run` dispatches per tick — the issue's "the worst tick is bounded" (Accessible Ops factor VI). Rules matched beyond the budget are recorded, not run. @default 3 */
  budget?: number;
  /** The rule table — build with `when()`/`eq()`/`run()`/`report()` from `@intentius/chant/op`. Non-empty; every rule id must be unique. */
  rules: ConvergeRule<ConvergeSymptom>[];
  /**
   * Cron expression. When set, a TemporalSchedule fires the workflow; omit
   * for one-shot `chant run` on the local executor — also the test story
   * (issue: "one-shot runnable locally for a single tick").
   */
  schedule?: string;
  /** Run `chant lifecycle diff --live` in the Observe phase (queries live state). @default true */
  live?: boolean;
  /** Override the task queue. Defaults to `name`. */
  taskQueue?: string;
}

export interface ConvergeOpResources {
  /** Op resource — generates the observe->converge workflow. */
  op: InstanceType<typeof OpResource>;
  /** Temporal schedule, present only when `schedule` was given. */
  schedule?: InstanceType<typeof TemporalSchedule>;
}

export function ConvergeOp(config: ConvergeOpConfig): ConvergeOpResources {
  const taskQueue = config.taskQueue ?? config.name;
  const dial = config.dial ?? "observe";
  const budget = config.budget ?? 3;
  const live = config.live ?? true;

  // ── Build-time refusals (#1484) ─────────────────────────────────────────
  // Thrown here, at Op-construction time — the same "refuse in the factory,
  // named, before anything runs" shape ApplyOp's `compensate` check already
  // uses. Cross-Op refusals that need the *whole* discovered graph (an
  // unknown op referenced by `run()`, a mutating/destructive dispatch target
  // whose own verb class the dial disallows) can't be checked here — a
  // sibling `*.op.ts` file's Op may not exist yet at the moment this factory
  // runs — and are instead TMP014's job
  // (../lint/post-synth/tmp014-converge-rule-refusals.ts), which runs after
  // the whole project is resolved.

  if (config.rules.length === 0) {
    throw new Error(`ConvergeOp "${config.name}": at least one rule is required — an empty table has nothing to converge.`);
  }
  const dupes = duplicateRuleIds(config.rules);
  if (dupes.length > 0) {
    throw new Error(
      `ConvergeOp "${config.name}": duplicate rule id(s) [${dupes.join(", ")}] — flap-damping counters are keyed by id, so ids must be unique.`,
    );
  }
  if (!Number.isInteger(budget) || budget < 0) {
    throw new Error(`ConvergeOp "${config.name}": budget must be a non-negative integer, got ${budget}`);
  }
  for (const rule of config.rules) {
    if (!rule.why || rule.why.trim().length === 0) {
      // Belt-and-suspenders: when() already refuses this, but a rule table
      // assembled by hand (bypassing when()) reaches here too.
      throw new Error(`ConvergeOp "${config.name}", rule "${rule.id}": every rule must carry its why — refused at build.`);
    }
    if (!isWellFormedPredicate(rule.when, CONVERGE_SYMPTOM_FIELDS)) {
      throw new Error(
        `ConvergeOp "${config.name}", rule "${rule.id}": predicate is outside the evaluable subset — build it from ` +
          `eq/neq/gt/gte/lt/lte/truthy/falsy/allOf/anyOf over a field ConvergeSymptom actually produces.`,
      );
    }
  }

  const snapshotStep = activity("lifecycleSnapshot", { env: config.env }, { id: "snapshot" });
  const diffStep = activity("lifecycleDiff", { env: config.env, live }, { id: "diff", profile: "fastIdempotent" });
  diffStep.outcomeAttribute = { name: "Drift", from: "drifted" };

  // convergeTick's args are the rule table itself — too shaped (recursive
  // predicates, a discriminated action union) for a hand-mirrored zod
  // contract to earn its keep, the same "deliberately partial" call
  // activity-contracts.ts already makes for kubectlApply/helmInstall's
  // multi-field args. TMP012 skips an uncontracted `fn`, not flags it — see
  // that module's doc. The `preflightDrift` step-output reference below is
  // still fully validated: TMP013's producer-side checks only need
  // `lifecycleDiff`'s own contract, which is registered.
  const tickStep = activity(
    "convergeTick",
    {
      opName: config.name,
      env: config.env,
      dial,
      budget,
      rules: config.rules,
      preflightDrift: diffStep.out.drifted,
    },
    "longInfra",
  );
  tickStep.outcomeAttribute = { name: "Remediated", from: "remediated" };

  const op = Op({
    name: config.name,
    overview: `Converge the ${config.env} environment toward its declaration (dial: ${dial})`,
    taskQueue,
    searchAttributes: {
      Converge: "true",
      Env: config.env,
      Dial: dial,
    },
    phases: [phase("Observe", [snapshotStep, diffStep]), phase("Converge", [tickStep])],
  });

  if (!config.schedule) {
    return { op };
  }

  // Overlap policy (#1484 acceptance criterion: "skip-and-report when a
  // prior remediation is in flight ... never queue"). `"Skip"` is Temporal's
  // schedule-level implementation of exactly that: if the previous tick's
  // workflow run is still executing when the next fire time arrives, the new
  // run is dropped rather than queued or run concurrently. There is no
  // per-tick "in flight" ledger record for the skipped fire to produce —
  // nothing ran, so nothing observed, classified, or dispatched; the skip
  // itself is visible in the Temporal UI's schedule history, not in
  // `converge.jsonl`.
  const schedule = new TemporalSchedule({
    scheduleId: `${config.name}-schedule`,
    spec: { cronExpressions: [config.schedule] },
    action: {
      workflowType: kebabToCamel(config.name) + "Workflow",
      taskQueue,
    },
    policies: { overlap: "Skip" },
  } as Record<string, unknown>);

  return { op, schedule };
}
