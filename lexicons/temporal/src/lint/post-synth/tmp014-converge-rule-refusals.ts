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
 * Flags:
 *  - a rule with no (or a blank) `why` — every rule must carry its
 *    rationale (Accessible Ops factor III),
 *  - a rule whose predicate isn't in the evaluable subset
 *    (`isWellFormedPredicate`, re-validated here as the runtime backstop
 *    over a rule table not authored through `when()`),
 *  - a `run()` action naming an Op no declared `Temporal::Op` entity has as
 *    its `name`,
 *  - a `run()` action dispatching a `mutating` Op while the ConvergeOp's own
 *    dial is `"observe"` (observe never free-runs a mutation — report only),
 *  - a `run()` action dispatching a `destructive` Op under any dial other
 *    than `"apply"`, or under `"apply"` when that target Op has no approval
 *    gate anywhere in its own phases.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { classifyOpVerbClass, isGated, isWellFormedPredicate } from "@intentius/chant/op";
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
    "A ConvergeOp rule table: run() must name a declared Op, a mutating/destructive dispatch must be permitted by the dial, a destructive target must be gated, and every rule must carry its why",

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
        if (verbClass === "mutating" && dial === "observe") {
          push(`dispatches "${targetName}" (mutating), but dial "observe" only permits read-only ops to free-run — report instead, or raise the dial`);
        }
        if (verbClass === "destructive") {
          if (dial !== "apply") {
            push(`dispatches "${targetName}" (destructive), but dial "${dial}" never permits a destructive dispatch — only "apply" does, and only when gated`);
          } else if (!isGated(target)) {
            push(`dispatches "${targetName}" (destructive), but that Op has no approval gate anywhere in its phases — a destructive dispatch target must be gated`);
          }
        }
      }
    }

    return diagnostics;
  },
};
