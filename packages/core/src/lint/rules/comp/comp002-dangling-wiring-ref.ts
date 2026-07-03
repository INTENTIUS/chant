/**
 * COMP002: dangling-wiring-ref
 *
 * Flags a wiring reference (`@Phase.field` or `@<component>.publish.*`,
 * carried in a step's `imageRef`/`jar`/`revision`/`inputs`/any other
 * capability-specific field — see ../../../components/component.ts's
 * `Wiring`) that points at a phase or component that does not exist:
 *
 *  - `@Phase.field` naming a phase not declared anywhere in this component's
 *    own `deploy` (top-level phase names only — a nested fan-out phase's
 *    name is addressed by its own name, never a parent's, matching how
 *    ../../../components/driver.ts's `resolveWiring` keys `phaseOutputs` by
 *    the phase the step ran directly under).
 *  - `@<component>.publish.<field>` naming a component that either is not
 *    discovered at all, or is discovered but not listed in this component's
 *    `dependsOn` — the graph only resolves an artifact reference for a
 *    declared dependency (composition-and-wiring.mdx#cross-component-outputs).
 *
 * Triggers on: `imageRef: "@Build.digest"` when no phase named "Build"
 * exists, or `jar: "@some-lib.publish.uri"` when "some-lib" is undiscovered
 * or missing from `dependsOn`.
 * OK: `imageRef: "@Publish.digest"` when a "Publish" phase exists in the same
 * component, or `jar: "@jar-lib.publish.uri"` when "jar-lib" is discovered
 * and listed in `dependsOn`.
 */

import type { ComponentCheck, ComponentCheckContext, ComponentCheckDiagnostic } from "../../component-checks";
import { collectWiringRefs, topLevelPhaseNames, walkComponent } from "./support";

export const comp002DanglingWiringRefRule: ComponentCheck = {
  id: "COMP002",
  severity: "error",
  category: "correctness",
  description: "A wiring reference (@Phase.field or @component.publish.*) points at a phase or component that does not exist",
  check(ctx: ComponentCheckContext): ComponentCheckDiagnostic[] {
    const diagnostics: ComponentCheckDiagnostic[] = [];

    for (const [name, { component, filePath }] of ctx.components) {
      const phaseNames = topLevelPhaseNames(component);
      const dependsOn = new Set(component.dependsOn ?? []);
      const { steps } = walkComponent(component);

      for (const { step, phaseName } of steps) {
        for (const ref of collectWiringRefs(step)) {
          if (ref.kind === "prior-step") {
            if (phaseNames.has(ref.phaseName)) continue;
            diagnostics.push({
              checkId: "COMP002",
              severity: "error",
              component: name,
              file: filePath,
              message:
                `Component "${name}": step "${step.kind}" (in phase "${phaseName}") references "@${ref.phaseName}.${ref.field}", ` +
                `but no phase named "${ref.phaseName}" exists in this component's "deploy". Known phases: ` +
                `${[...phaseNames].join(", ") || "(none)"}.`,
            });
            continue;
          }

          // ref.kind === "component-artifact"
          const target = ctx.components.get(ref.componentName);
          if (!target) {
            diagnostics.push({
              checkId: "COMP002",
              severity: "error",
              component: name,
              file: filePath,
              message:
                `Component "${name}": step "${step.kind}" (in phase "${phaseName}") references ` +
                `"@${ref.componentName}.publish.${ref.field}", but no component named "${ref.componentName}" was discovered.`,
            });
            continue;
          }

          if (!dependsOn.has(ref.componentName)) {
            diagnostics.push({
              checkId: "COMP002",
              severity: "error",
              component: name,
              file: filePath,
              message:
                `Component "${name}": step "${step.kind}" (in phase "${phaseName}") references ` +
                `"@${ref.componentName}.publish.${ref.field}", but "${ref.componentName}" is not listed in this ` +
                `component's "dependsOn" — the graph only resolves an artifact reference for a declared dependency. ` +
                `Add "${ref.componentName}" to dependsOn.`,
            });
          }
        }
      }
    }

    return diagnostics;
  },
};
