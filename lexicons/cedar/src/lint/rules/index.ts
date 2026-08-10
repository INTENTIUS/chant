import type { LintRule } from "@intentius/chant/lint/rule";
import { cedarPolicyShapeRule } from "./policy-shape";

export { cedarPolicyShapeRule, CEDAR_EFFECTS } from "./policy-shape";

/**
 * All lint rules provided by this lexicon (imported by plugin.ts's lintRules()).
 *
 * Pre-synth rules are wired by hand — unlike post-synth checks, they are not
 * auto-discovered. Add the import above and the entry below.
 */
export const rules: LintRule[] = [cedarPolicyShapeRule];
