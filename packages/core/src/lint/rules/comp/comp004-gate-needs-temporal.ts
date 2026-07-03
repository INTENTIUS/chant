/**
 * COMP004: gate-needs-temporal
 *
 * Flags a `gate` step anywhere in a component's composition — a durable,
 * human-approval wait that cannot run on the local in-process executor (see
 * ../../../components/driver.ts's `DriverGateUnsupportedError` and
 * docs/components/orchestration.mdx's "Temporal is optional" aside: "gates ...
 * require the durable (Temporal) execution backend").
 *
 * The component contract has no per-component backend/executor field (the
 * backend is chosen per *run*, via `chant run --temporal`, per epic #551 §8 —
 * intentionally not part of the declaration, so the same component graduates
 * to Temporal without changing its definition). That means lint cannot tell,
 * from the declaration alone, whether a given `gate` will actually run under
 * Temporal when this component is deployed — every `gate` is a standing
 * "this component needs the durable backend" fact worth surfacing, not a
 * mistake to silently allow. Acknowledge it explicitly with a **file-level**
 * disable directive once the durable backend is genuinely intended (see
 * lint-rules/disable-directives.mdx) — a COMP* diagnostic carries no real
 * line/column (it is reported for the whole component; see
 * ../../component-checks.ts), so only the file-level `chant-disable` form is
 * honored for these rules — `-line`/`-next-line` do not suppress a COMP*
 * diagnostic (see ../../../cli/commands/lint.ts's
 * `runComponentCheckDiagnostics`):
 *
 * ```ts
 * // chant-disable COMP004 -- graduates to --temporal for the human approval wait
 * ```
 *
 * Triggers on: any `gate` step in `deploy`/`rollback` with no matching
 * file-level disable directive.
 * OK: a component with no `gate` steps at all, or a `gate` whose file-level
 * disable directive documents the Temporal graduation.
 */

import type { ComponentCheck, ComponentCheckContext, ComponentCheckDiagnostic } from "../../component-checks";
import { walkComponent } from "./support";

export const comp004GateNeedsTemporalRule: ComponentCheck = {
  id: "COMP004",
  severity: "error",
  category: "correctness",
  description: "A gate step requires the durable (Temporal) execution backend — it cannot run on the local executor",
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
            `Component "${name}": gate "${gate.signalName}" (phase "${phaseName}") requires the durable (Temporal) ` +
            `execution backend — it cannot run on the local in-process executor. If this component is meant to run ` +
            `with "chant run --temporal", suppress with a file-level "// chant-disable COMP004 -- <reason>" comment ` +
            `anywhere in this file to document that intent explicitly.`,
        });
      }
    }

    return diagnostics;
  },
};
