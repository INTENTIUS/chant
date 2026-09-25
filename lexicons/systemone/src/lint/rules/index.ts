import type { LintRule } from "@intentius/chant/lint/rule";
import { noLiteralKeyRule } from "./sys001-no-literal-key";

export { noLiteralKeyRule } from "./sys001-no-literal-key";

/** All lint rules provided by this lexicon (imported by plugin.ts's lintRules()). */
export const rules: LintRule[] = [noLiteralKeyRule];
