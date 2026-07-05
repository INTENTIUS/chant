/**
 * COMP003: mutating-no-rollback
 *
 * Flags a mutating capability step whose family has no known native/starter
 * rollback and no explicit opt-out — the "mutating capability with no
 * rollback and no explicit opt-out reason" guardrail from epic #551 §7 and
 * §"Failure modes".
 *
 * Each capability declares its rollback disposition via `rollbackPolicy`
 * (../../../components/capability.ts): `"native"` (a paired `rollback`, e.g.
 * `cfn-deploy`/`ecs-update-service`/`lambda-deploy`/`code-deploy`),
 * `"none-by-design"` (nothing to compensate — the build/publish and wait/verify
 * families, whose outputs are immutable/content-addressed or read-only), or
 * `"needs-opt-out"` (a mutating verb with no native rollback and no safe undo,
 * e.g. `s3-sync`/`run-migration`). This rule flags only `"needs-opt-out"` steps
 * lacking an explicit opt-out. It reads the disposition from the project's
 * capability registry (`ctx.rollbackPolicies`, built by `chant lint` from the
 * active lexicons + core starter — the same seam COMP005 uses for
 * `ctx.knownKinds`), never a hard-coded verb list, so the aws leaves'
 * dispositions come from the aws lexicon that owns them.
 *
 * The opt-out: since the capability interface and schema are out of scope for
 * this issue (`Step` already has `additionalProperties: true` — see
 * component.schema.json), a component may attach a `noRollback: "<reason>"`
 * string property directly on the step to declare the compensation gap is
 * intentional and understood, or supply its own explicit compensation via a
 * component-level `rollback` field (as the ALB/ECS pilot does with
 * `rollback-previous`) or a sibling `rollback-previous`/`snapshot-before` step
 * in the same phase.
 *
 * Triggers on: a bare `{ kind: "run-migration", ... }` step with no
 * `noRollback` reason, no component-level `rollback`, and no sibling
 * `rollback-previous`/`snapshot-before` step.
 * OK: `{ kind: "run-migration", ..., noRollback: "forward-only migration, ..." }`,
 * or a component `rollback` field, or a sibling compensation step.
 */

import type { ComponentCheck, ComponentCheckContext, ComponentCheckDiagnostic } from "../../component-checks";
import { walkComponent } from "./support";

/**
 * A step is flagged only when its verb's rollback disposition is
 * `"needs-opt-out"` — a mutating capability with no native rollback and no safe
 * undo. That disposition is the capability's own declaration (`rollbackPolicy`,
 * ../../../components/capability.ts), surfaced to this rule via
 * `ctx.rollbackPolicies` (built from the project's registry by `chant lint`,
 * exactly like `ctx.knownKinds` for COMP005). Verbs with a native rollback
 * (`cfn-deploy`, …) or nothing to compensate (build/publish/wait) are
 * `"native"`/`"none-by-design"` and never flagged. When no registry was
 * resolved (a direct unit test), an unknown verb defaults to
 * `"none-by-design"` — the rule stays silent rather than guessing.
 */
function policyFor(ctx: ComponentCheckContext, kind: string): string {
  return ctx.rollbackPolicies?.get(kind) ?? "none-by-design";
}

/** A sibling step kind that itself is (or supplies) compensation — its presence in the same phase is treated as the component handling rollback explicitly, not silence. */
const COMPENSATION_SIBLING_KINDS = new Set(["rollback-previous", "snapshot-before"]);

export const comp003MutatingNoRollbackRule: ComponentCheck = {
  id: "COMP003",
  severity: "error",
  category: "correctness",
  description: "A mutating capability step has no known rollback and no explicit opt-out (noRollback reason, component rollback, or a compensation sibling step)",
  check(ctx: ComponentCheckContext): ComponentCheckDiagnostic[] {
    const diagnostics: ComponentCheckDiagnostic[] = [];

    for (const [name, { component, filePath }] of ctx.components) {
      const hasComponentRollback = Array.isArray(component.rollback) && component.rollback.length > 0;

      // Walk every step (including inside nested fan-out phases and
      // onFailure compensation phases — see support.ts's walkComponent) so a
      // mutating step nested inside a fan-out unit (e.g. a Neo4j-style
      // per-instance phase) is inspected the same as a top-level one.
      const { steps } = walkComponent(component);

      // Group steps by the exact Phase object they live under (identity, not
      // name — two different nested phases can share a display name) so the
      // "sibling in the same phase" compensation check only looks at true
      // siblings, never steps from an unrelated phase of the same name.
      const stepsByPhase = new Map<object, typeof steps>();
      for (const walked of steps) {
        const group = stepsByPhase.get(walked.phase) ?? [];
        group.push(walked);
        stepsByPhase.set(walked.phase, group);
      }

      for (const walked of steps) {
        const { step, phaseName, phase } = walked;
        if (policyFor(ctx, step.kind) !== "needs-opt-out") continue;

        const noRollback = (step as { noRollback?: unknown }).noRollback;
        const hasStepOptOut = typeof noRollback === "string" && noRollback.trim().length > 0;
        if (hasStepOptOut || hasComponentRollback) continue;

        const siblings = stepsByPhase.get(phase) ?? [];
        const hasCompensationSibling = siblings.some((s) => COMPENSATION_SIBLING_KINDS.has(s.step.kind));
        if (hasCompensationSibling) continue;

        diagnostics.push({
          checkId: "COMP003",
          severity: "error",
          component: name,
          file: filePath,
          message:
            `Component "${name}": step "${step.kind}" (phase "${phaseName}") is a mutating capability with no ` +
            `known native rollback and no explicit opt-out. Add a "noRollback: \\"<reason>\\"" property to the step, ` +
            `a component-level "rollback" phase, or a sibling "rollback-previous"/"snapshot-before" step in the same phase.`,
        });
      }
    }

    return diagnostics;
  },
};
