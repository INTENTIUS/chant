/**
 * COMP006: shell-needs-reason
 *
 * Flags a `shell` step with no (or empty/blank) `reason` — the escape-hatch
 * discipline from epic #551 §7 and §"What chant adds": "raw `shell` without a
 * declared reason" gets flagged. `shell` is the deliberate escape hatch
 * (../../../components/verbs/shell.ts) for reaching past the capability set;
 * `ShellInput.reason` is already a required field on the typed
 * `createShellCapability` input, but a hand-authored/JSON-only component (the
 * contract's whole point — see component-contract.mdx's "portable, not
 * chant-only" framing) is not type-checked against that interface, so the raw
 * JSON contract's `Step` (open `additionalProperties`) does not itself
 * enforce it. This rule enforces the same discipline at the composition
 * level, for every authoring form.
 *
 * Triggers on: `{ kind: "shell", cmd: "..." }` with no `reason`, or
 * `reason: ""` / `reason: "   "`.
 * OK: `{ kind: "shell", cmd: "...", reason: "no capability covers <x> yet" }`.
 */

import type { ComponentCheck, ComponentCheckContext, ComponentCheckDiagnostic } from "../../component-checks";
import { walkComponent } from "./support";

export const comp006ShellNeedsReasonRule: ComponentCheck = {
  id: "COMP006",
  severity: "error",
  category: "correctness",
  description: 'A raw "shell" escape-hatch step has no declared reason',
  check(ctx: ComponentCheckContext): ComponentCheckDiagnostic[] {
    const diagnostics: ComponentCheckDiagnostic[] = [];

    for (const [name, { component, filePath }] of ctx.components) {
      const { steps } = walkComponent(component);

      for (const { step, phaseName } of steps) {
        if (step.kind !== "shell") continue;
        const reason = (step as { reason?: unknown }).reason;
        const hasReason = typeof reason === "string" && reason.trim().length > 0;
        if (hasReason) continue;

        diagnostics.push({
          checkId: "COMP006",
          severity: "error",
          component: name,
          file: filePath,
          message:
            `Component "${name}": "shell" step (phase "${phaseName}") is the escape hatch and must declare why no ` +
            `capability covers this case — add a non-empty "reason" property (e.g. "reason: \\"no capability for X yet\\"").`,
        });
      }
    }

    return diagnostics;
  },
};
