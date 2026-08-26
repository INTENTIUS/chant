/**
 * TMP014: converge-rule-refusals (#1484)
 *
 * Cross-Op build-time refusals for a `ConvergeOp`'s rule table — the checks
 * `../../composites/converge-op.ts`'s factory can't make on its own, since
 * they need the *whole* discovered graph of `Temporal::Op` entities
 * (`PostSynthContext.entities`), not just the ConvergeOp instance under
 * construction: a sibling `*.op.ts` file's Op may not exist yet at the
 * moment a composite factory runs, the same reason TMP012/TMP013 exist as
 * post-synth checks rather than builder-time throws.
 *
 * A `ConvergeOp`-produced Op is identified by its own
 * `searchAttributes.Converge === "true"` marker (mirroring `ApplyOp`'s
 * `{ Apply: "true" }` / `WatchOp`'s `{ Watch: "true" }`); its rule table is
 * read back off the `convergeTick` activity step's `args.rules` (there is no
 * dedicated `OpConfig` field for it — see `converge-op.ts`'s doc on why the
 * rule table travels as a step's args instead of a bespoke config field).
 *
 * Flags (pre-merge review of #1954 tightened the last three to match issue
 * #1484's own Autonomy table — see `converge-op.ts`'s module doc):
 *  - a rule with no (or a blank) `why` — every rule must carry its
 *    rationale (Accessible Ops factor III),
 *  - a rule whose predicate isn't in the evaluable subset
 *    (`isWellFormedPredicate`, re-validated here as the runtime backstop
 *    over a rule table not authored through `when()`),
 *  - a `run()` action naming an Op no declared `Temporal::Op` entity has as
 *    its `name`,
 *  - a `run()` action dispatching a `mutating` Op under any dial other than
 *    `"apply"` — the issue's Autonomy table gives `reconcile` "open PR", not
 *    "run directly"; opening a PR is out of v1 scope (epic #1487's
 *    `onDrift`-channel open question), so `reconcile` refuses the mutating
 *    dispatch rather than silently escalating it to "run directly",
 *  - a `run()` action dispatching a `destructive` Op under any dial,
 *    unconditionally — a destructive target's required gate can never
 *    actually run: `dispatchOp` always shells `chant run <op>` without
 *    `--temporal`, and the local executor refuses any gated op outright
 *    (`LocalGateUnsupportedError`), so "destructive + apply + gated"
 *    guarantees immediate dispatch failure. Durable gated dispatch is
 *    #1485's design to own; v1 refuses the target rather than shipping a
 *    path that can never succeed,
 *  - a rule whose predicate reads `adoptCount` while its action is `run()`
 *    against a `mutating` Op — adopt safety (never auto-claiming an unowned
 *    resource) is enforced here, not merely documented: a rule that reads
 *    the adopt signal has no business dispatching a mutation.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { classifyOpVerbClass, isWellFormedPredicate, predicateReferencesField } from "@intentius/chant/op";
import type { ConvergeRule, OpConfig } from "@intentius/chant/op";
import { CONVERGE_SYMPTOM_FIELDS, type ConvergeSymptom } from "@intentius/chant/lifecycle/symptoms";

function looksLikeOpProps(props: Record<string, unknown>): boolean {
  return typeof props.name === "string" && Array.isArray(props.phases);
}

/** Read a ConvergeOp's rule table back off its `convergeTick` step's `args.rules`. `undefined` if this doesn't look like a ConvergeOp-shaped Op (defensive — never crashes the build over an unexpected shape). */
function findConvergeRules(props: OpConfig): ConvergeRule<ConvergeSymptom>[] | undefined {
  for (const phase of props.phases) {
    for (const step of phase.steps) {
      if (step.kind === "activity" && step.fn === "convergeTick") {
        const rules = step.args?.rules;
        return Array.isArray(rules) ? (rules as ConvergeRule<ConvergeSymptom>[]) : undefined;
      }
    }
  }
  return undefined;
}

export const tmp014: PostSynthCheck = {
  id: "TMP014",
  description:
    "A ConvergeOp rule table: run() must name a declared Op, a mutating dispatch requires dial apply (reconcile opens a PR in a future version, not implemented in v1), a destructive dispatch is refused outright in v1 (the local dispatch executor can't honor a gate), an adoptCount-reading rule may not dispatch a mutation, and every rule must carry its why",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    const opsByName = new Map<string, OpConfig>();
    for (const entity of ctx.entities.values()) {
      const et = (entity as unknown as Record<string, unknown>).entityType as string;
      if (et !== "Temporal::Op") continue;
      const rawProps = ((entity as { props?: Record<string, unknown> }).props ?? {}) as Record<string, unknown>;
      if (!looksLikeOpProps(rawProps)) continue;
      const opProps = rawProps as unknown as OpConfig;
      opsByName.set(opProps.name, opProps);
    }

    for (const [entityKey, entity] of ctx.entities) {
      const et = (entity as unknown as Record<string, unknown>).entityType as string;
      if (et !== "Temporal::Op") continue;

      const rawProps = ((entity as { props?: Record<string, unknown> }).props ?? {}) as Record<string, unknown>;
      if (!looksLikeOpProps(rawProps)) continue;
      const props = rawProps as unknown as OpConfig;
      if (props.searchAttributes?.Converge !== "true") continue;

      const dial = props.searchAttributes?.Dial ?? "observe";
      const rules = findConvergeRules(props);
      if (!rules) continue;

      for (const rule of rules) {
        const label = typeof rule?.id === "string" ? rule.id : "(unnamed rule)";
        const push = (message: string): void => {
          diagnostics.push({
            checkId: "TMP014",
            severity: "error",
            message: `ConvergeOp "${props.name}", rule "${label}": ${message}`,
            entity: entityKey,
            lexicon: "temporal",
          });
        };

        if (typeof rule?.why !== "string" || rule.why.trim().length === 0) {
          push("every rule must carry its why — refused at build");
          continue;
        }
        if (!isWellFormedPredicate(rule.when, CONVERGE_SYMPTOM_FIELDS)) {
          push("predicate is outside the evaluable subset (build it from eq/neq/gt/gte/lt/lte/truthy/falsy/allOf/anyOf over a known symptom field)");
          continue;
        }
        if (!rule.then || rule.then.kind !== "run") continue;

        const targetName = rule.then.op;
        const target = opsByName.get(targetName);
        if (!target) {
          push(`references unknown op "${targetName}" — no declared Op has that name`);
          continue;
        }

        const verbClass = classifyOpVerbClass(target);

        // Mutating: the issue's Autonomy table gives `reconcile` "open PR",
        // not "run directly" — building that channel is out of v1 scope
        // (epic #1487's onDrift-channel open question), so only `apply`
        // (the dial the issue's table marks "run, gated per op") may free-run
        // a mutating dispatch. Refusing this at build is the honest
        // alternative to silently escalating `reconcile`'s authority to
        // match `apply`.
        if (verbClass === "mutating" && dial !== "apply") {
          const escalationNote =
            dial === "reconcile"
              ? ` — the issue's table answer for "reconcile" is "open PR", which v1 does not implement (see epic #1487's onDrift-channel open question); this Op would otherwise silently run a mutation "reconcile" was never granted`
              : "";
          push(`dispatches "${targetName}" (mutating), but dial "${dial}" only permits a mutating dispatch under "apply"${escalationNote} — report instead, or raise the dial to "apply"`);
        }

        // Destructive: refused outright, regardless of dial or gate. A
        // destructive target is required to carry a gate, but the dispatch
        // executor can't honor one — `dispatchOp` always shells
        // `chant run <op>` without `--temporal`, and the local executor's
        // pre-flight rejects any gated op before it runs a single step
        // (`LocalGateUnsupportedError`). "destructive + apply + gated" reads
        // as a path to dispatch but is a dead cell: it can never actually
        // run. Durable gated dispatch (`--temporal` pass-through, or a
        // genuinely durable dispatch surface) is #1485's design to own;
        // until then this is refused rather than shipped as a path that
        // fails every time it's exercised.
        if (verbClass === "destructive") {
          push(
            `dispatches "${targetName}" (destructive) — destructive run() targets are refused in v1 under any dial: the local dispatch executor (\`chant run\`, no --temporal) refuses any gated op outright, so a destructive target's required gate guarantees immediate dispatch failure. Destructive remediation via ConvergeOp arrives once dispatch can run gated ops durably (#1485) — until then, remediate manually via a gated ApplyOp/ReconcileOp run.`,
          );
        }

        // Adopt safety: enforced, not just documented. A rule that reads
        // `adoptCount` — the "unowned resource" signal — has no honest
        // reason to dispatch a mutation; the only sanctioned action for that
        // signal is `report()`. (A destructive target already gets refused
        // above regardless of what its predicate reads.)
        if (verbClass === "mutating" && predicateReferencesField(rule.when, "adoptCount")) {
          push(
            `predicate reads "adoptCount" but dispatches "${targetName}" (mutating) — an unowned resource is reported, never auto-claimed by a dispatched mutation; use report() for a rule that reads the adopt signal`,
          );
        }
      }
    }

    return diagnostics;
  },
};
