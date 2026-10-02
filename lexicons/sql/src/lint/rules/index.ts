import type { LintRule } from "@intentius/chant/lint/rule";

/**
 * The lexicon's source-level lint rules, returned by `lintRules()`.
 *
 * Empty until the ClickHouse entity model and its parser land (chant #3197):
 * every rule this lexicon has planned reads a parsed table or view, and a rule
 * written before there is anything to read would be a placeholder.
 */
export const rules: LintRule[] = [];
