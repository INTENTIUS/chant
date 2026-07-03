/**
 * COMP003: mutating-no-rollback
 *
 * Flags a mutating capability step whose family has no known native/starter
 * rollback and no explicit opt-out — the "mutating capability with no
 * rollback and no explicit opt-out reason" guardrail from epic #551 §7 and
 * §"Failure modes".
 *
 * chant's starter capability set (../../../components/starter-plugin.ts)
 * already resolves this for its own apply/host-delivery leaves: `cfn-deploy`,
 * `ecs-update-service`, `lambda-deploy`, and `code-deploy` declare a native
 * `rollback` (see ../../../components/verbs/apply.ts,
 * ../../../components/verbs/host-delivery.ts); the whole publish family
 * (`docker-build`/`zip-package`/`jvm-build`, `publish-image`,
 * `publish-artifact`/`load-image-on-host`) and the wait/verify family declare
 * none *by design*, documented inline in their own module — an already-built
 * or already-published, immutable, content-addressed artifact is not itself a
 * problem to compensate (see ../../../components/verbs/publish.ts's own
 * `publish-image` docstring, which `publish-artifact`/`load-image-on-host`
 * share verbatim). Lint cannot see a capability's own `rollback`
 * implementation (components declare data, not capability instances — see
 * ../../component-checks.ts), so this rule only flags the remaining
 * starter-set families that are mutating but have neither a native rollback
 * nor a documented no-rollback-by-design reason: `s3-sync`, `cdn-invalidate`,
 * `run-migration`, `emr-start-job-run`, `emr-submit-step`, `copy-to-host`,
 * `remote-exec` (all still typed stubs per ../../../components/capability.ts's
 * "no cloud implementation yet" contract) — plus any capability `kind`
 * outside the starter set entirely (a third-party plugin lint has no
 * rollback knowledge of).
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

/** Starter-set mutating kinds with a known native rollback (../../../components/verbs/apply.ts, host-delivery.ts) — never flagged. */
const NATIVE_ROLLBACK_KINDS = new Set(["cfn-deploy", "ecs-update-service", "lambda-deploy", "code-deploy"]);

/** Starter-set mutating kinds documented as no-rollback-by-design (build/publish: nothing to compensate — an already-built/published, immutable, content-addressed artifact; see ../../../components/verbs/build.ts, publish.ts) — never flagged. */
const NO_ROLLBACK_BY_DESIGN_KINDS = new Set([
  "docker-build",
  "zip-package",
  "jvm-build",
  "publish-image",
  "publish-artifact",
  "load-image-on-host",
]);

/** Starter-set mutating kinds with neither — flagged unless the step/component opts out explicitly. */
const NEEDS_OPT_OUT_KINDS = new Set([
  "s3-sync",
  "cdn-invalidate",
  "run-migration",
  "emr-start-job-run",
  "emr-submit-step",
  "copy-to-host",
  "remote-exec",
]);

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
        if (!NEEDS_OPT_OUT_KINDS.has(step.kind)) continue;
        if (NATIVE_ROLLBACK_KINDS.has(step.kind) || NO_ROLLBACK_BY_DESIGN_KINDS.has(step.kind)) continue;

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
