/**
 * COMP001: publishes-but-never-applies
 *
 * Flags a component that publishes an image/artifact (a `publish-image`,
 * `publish-artifact`, or `load-image-on-host` step) that nothing ever
 * consumes: neither an apply/submit step later in the same component (via a
 * `@Phase.field` prior-step reference into the publish phase) nor any other
 * component (via `@<this-component>.publish.uri|digest|key`). A publish step
 * with no consumer either belongs to a producer/library component another
 * component should depend on, or is dead composition — see epic #551 §7
 * ("What chant adds") and §"Failure modes" (renamed/orphaned sprawl).
 *
 * Triggers on: a `service`-shaped component whose `publish-image` output is
 * never referenced by its own Apply phase or by any sibling component.
 * OK: the publish output is referenced via `@Publish.digest` (same
 * component) or `@<name>.publish.uri` (a consumer component).
 */

import type { ComponentCheck, ComponentCheckContext, ComponentCheckDiagnostic } from "../../component-checks";
import { collectWiringRefs, walkComponent } from "./support";

const PUBLISH_KIND = /^(publish-image|publish-artifact|load-image-on-host)$/;

export const comp001PublishesNeverAppliesRule: ComponentCheck = {
  id: "COMP001",
  severity: "error",
  category: "correctness",
  description: "A publish step's output is never consumed by an apply/submit step, in this component or any other",
  check(ctx: ComponentCheckContext): ComponentCheckDiagnostic[] {
    const diagnostics: ComponentCheckDiagnostic[] = [];

    // Every `@<name>.publish.*` reference anywhere across every discovered
    // component — a publish step in component X is "consumed" if some
    // component (including X itself, via `@Phase.field`) references it.
    const referencedComponentPublishes = new Set<string>();
    for (const { component } of ctx.components.values()) {
      const { steps } = walkComponent(component);
      for (const { step } of steps) {
        for (const ref of collectWiringRefs(step)) {
          if (ref.kind === "component-artifact") referencedComponentPublishes.add(ref.componentName);
        }
      }
    }

    for (const [name, { component, filePath }] of ctx.components) {
      const { steps } = walkComponent(component);
      const publishSteps = steps.filter(({ step }) => PUBLISH_KIND.test(step.kind));
      if (publishSteps.length === 0) continue;

      // Consumed if: (a) some other/same component references
      // `@<name>.publish.*`, or (b) a same-component prior-step reference
      // points at the publish step's own phase (e.g. `@Publish.digest` used
      // by a later Apply step in the same component).
      if (referencedComponentPublishes.has(name)) continue;

      const publishPhaseNames = new Set(publishSteps.map(({ phaseName }) => phaseName));
      const consumedByPriorStepRef = steps.some(({ step }) =>
        collectWiringRefs(step).some((ref) => ref.kind === "prior-step" && publishPhaseNames.has(ref.phaseName)),
      );
      if (consumedByPriorStepRef) continue;

      diagnostics.push({
        checkId: "COMP001",
        severity: "error",
        component: name,
        file: filePath,
        message:
          `Component "${name}" publishes an artifact (${[...publishPhaseNames].join(", ")} phase) that is never ` +
          `consumed — no apply/submit step in this component references it via "@${[...publishPhaseNames][0]}.<field>", ` +
          `and no other component references "@${name}.publish.<field>". If this is a producer/library ` +
          `component, a consumer should depend on it and reference its publish output; otherwise this publish step ` +
          `is dead composition.`,
      });
    }

    return diagnostics;
  },
};
