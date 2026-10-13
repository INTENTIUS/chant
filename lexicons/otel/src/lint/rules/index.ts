import type { LintRule } from "@intentius/chant/lint/rule";
import { componentIdSyntaxRule } from "./component-id-syntax";
import { literalCredentialRule } from "./literal-credential";

export { componentIdSyntaxRule } from "./component-id-syntax";
export { literalCredentialRule } from "./literal-credential";

/** All lint rules provided by this lexicon (imported by plugin.ts's lintRules()). */
export const rules: LintRule[] = [componentIdSyntaxRule, literalCredentialRule];
