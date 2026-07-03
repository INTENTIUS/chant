/**
 * COMP* composition lint rules (#562, epic #551) — the long-term entropy
 * guards over the discovered `Component` graph. See ../../component-checks.ts
 * for why these are `ComponentCheck`s (whole-project, post-discovery) rather
 * than `LintRule`s (single-file AST), and docs/lint-rules/composition.mdx for
 * the user-facing reference.
 */

import type { ComponentCheck } from "../../component-checks";
import { comp001PublishesNeverAppliesRule } from "./comp001-publishes-never-applies";
import { comp002DanglingWiringRefRule } from "./comp002-dangling-wiring-ref";
import { comp003MutatingNoRollbackRule } from "./comp003-mutating-no-rollback";
import { comp004GateNeedsTemporalRule } from "./comp004-gate-needs-temporal";
import { comp005CapabilityKindIsNounRule } from "./comp005-capability-kind-is-noun";
import { comp006ShellNeedsReasonRule } from "./comp006-shell-needs-reason";
import { comp007CompositionSprawlRule } from "./comp007-composition-sprawl";

export { comp001PublishesNeverAppliesRule } from "./comp001-publishes-never-applies";
export { comp002DanglingWiringRefRule } from "./comp002-dangling-wiring-ref";
export { comp003MutatingNoRollbackRule } from "./comp003-mutating-no-rollback";
export { comp004GateNeedsTemporalRule } from "./comp004-gate-needs-temporal";
export { comp005CapabilityKindIsNounRule } from "./comp005-capability-kind-is-noun";
export { comp006ShellNeedsReasonRule } from "./comp006-shell-needs-reason";
export { comp007CompositionSprawlRule } from "./comp007-composition-sprawl";

/** All seven COMP* checks, sorted by id. */
export function loadComponentChecks(): ComponentCheck[] {
  return [
    comp001PublishesNeverAppliesRule,
    comp002DanglingWiringRefRule,
    comp003MutatingNoRollbackRule,
    comp004GateNeedsTemporalRule,
    comp005CapabilityKindIsNounRule,
    comp006ShellNeedsReasonRule,
    comp007CompositionSprawlRule,
  ];
}
