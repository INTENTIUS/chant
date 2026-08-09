import type { LintRule } from "@intentius/chant/lint/rule";
import { tokenLiteralRule } from "./token-literal";

export { tokenLiteralRule } from "./token-literal";

/** All lint rules provided by this lexicon (imported by plugin.ts's lintRules()). */
export const rules: LintRule[] = [tokenLiteralRule];
