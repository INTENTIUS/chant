import type { LintRule } from "@intentius/chant/lint/rule";
import { planBeforeApplyRule } from "./plan-before-apply";

export { planBeforeApplyRule } from "./plan-before-apply";

/** All lint rules provided by this lexicon (imported by plugin.ts's lintRules()). */
export const rules: LintRule[] = [planBeforeApplyRule];
