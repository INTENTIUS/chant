import type { LintRule } from "@intentius/chant/lint/rule";
import { literalCredentialRule } from "./literal-credential";
import { promqlLiteralRule } from "./promql-literal";

export { literalCredentialRule, SECRET_FIELDS } from "./literal-credential";
export { promqlLiteralRule } from "./promql-literal";

/** All lint rules provided by this lexicon (imported by plugin.ts's lintRules()). */
export const rules: LintRule[] = [literalCredentialRule, promqlLiteralRule];
