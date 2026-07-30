import type { LintRule } from "@intentius/chant/lint/rule";
import { noSecretLiteralsRule } from "./ftn001-no-secret-literals";

export { noSecretLiteralsRule } from "./ftn001-no-secret-literals";

/** All lint rules provided by this lexicon (imported by plugin.ts's lintRules()). */
export const rules: LintRule[] = [noSecretLiteralsRule];
