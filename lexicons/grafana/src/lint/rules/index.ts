import type { LintRule } from "@intentius/chant/lint/rule";
import { uidSyntaxRule } from "./uid-syntax";
import { literalSecretRule } from "./literal-secret";

export { uidSyntaxRule } from "./uid-syntax";
export { literalSecretRule } from "./literal-secret";

/** All lint rules provided by this lexicon (imported by plugin.ts's lintRules()). */
export const rules: LintRule[] = [uidSyntaxRule, literalSecretRule];
