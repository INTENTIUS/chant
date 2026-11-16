import type { LintRule } from "@intentius/chant/lint/rule";
import { literalCredentialEnvRule } from "./literal-credential-env";

export { literalCredentialEnvRule } from "./literal-credential-env";

/** All lint rules provided by this lexicon (imported by plugin.ts's lintRules()). */
export const rules: LintRule[] = [literalCredentialEnvRule];
