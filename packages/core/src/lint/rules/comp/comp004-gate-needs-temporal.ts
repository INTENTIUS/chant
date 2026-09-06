/**
 * COMP004: gate-needs-temporal (the id is renamed in #2116; the behaviour
 * changed in #2119)
 *
 * Flags a `gate` step anywhere in a component's composition — the point where
 * a run stops and waits for a person. Since #2119 that is no longer a refusal
 * on the local executor: the driver decides the gate against the gate ledger
 * (`../../../op/gate.ts`), and one nobody has approved ends the run pending
 * `chant approve <component> <gate>`, to be re-decided next run.
 *
 * The rule survives the change because what it flags survives it. The
 * component contract has no per-component backend/executor field (the backend
 * is chosen per *run*, per epic #551 §8 — intentionally not part of the
 * declaration), so lint cannot tell from the declaration alone that a `gate`
 * is deliberate; every one is a standing "this component stops for a human"
 * fact worth surfacing, not a mistake to silently allow. Acknowledge it
 * explicitly with a **file-level**
 * disable directive once the durable backend is genuinely intended (see
 * lint-rules/disable-directives.mdx) — a COMP* diagnostic carries no real
 * line/column (it is reported for the whole component; see
 * ../../component-checks.ts), so only the file-level `chant-disable` form is
 * honored for these rules — `-line`/`-next-line` do not suppress a COMP*
 * diagnostic (see ../../../cli/commands/lint.ts's
 * `runComponentCheckDiagnostics`):
 *
 * ```ts
 * // chant-disable COMP004 -- the rollout waits on a release manager's approval
 * ```
 *
 * Triggers on: any `gate` step in `deploy`/`rollback` with no matching
 * file-level disable directive.
 * OK: a component with no `gate` steps at all, or a `gate` whose file-level
 * disable directive says who is expected to approve it and why.
 */

import type { ComponentCheck, ComponentCheckContext, ComponentCheckDiagnostic } from "../../component-checks";
import { walkComponent } from "./support";

export const comp004GateNeedsTemporalRule: ComponentCheck = {
  id: "COMP004",
  severity: "error",
  category: "correctness",
  description: "A gate step ends the run pending approval — acknowledge the human wait explicitly",
  check(ctx: ComponentCheckContext): ComponentCheckDiagnostic[] {
    const diagnostics: ComponentCheckDiagnostic[] = [];

    for (const [name, { component, filePath }] of ctx.components) {
      const { gates } = walkComponent(component);
      for (const { gate, phaseName } of gates) {
        diagnostics.push({
          checkId: "COMP004",
          severity: "error",
          component: name,
          file: filePath,
          message:
            `Component "${name}": gate "${gate.signalName}" (phase "${phaseName}") ends the run pending approval — ` +
            `a run that reaches it records the gate as a fact and stops there until someone runs ` +
            `"chant approve ${name} ${gate.signalName}", and no later phase runs. If that wait is intended, ` +
            `suppress with a file-level "// chant-disable COMP004 -- <reason>" comment anywhere in this file to ` +
            `document who approves it and why.`,
        });
      }
    }

    return diagnostics;
  },
};
