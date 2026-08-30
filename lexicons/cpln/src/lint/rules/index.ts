import type { LintRule } from "@intentius/chant/lint/rule";
import { noSecretLiteralsRule } from "./cpl001-no-secret-literals";
import { preferResourceReferenceRule } from "./cpl002-prefer-resource-reference";

export { noSecretLiteralsRule } from "./cpl001-no-secret-literals";
export { preferResourceReferenceRule } from "./cpl002-prefer-resource-reference";

/** All source-level lint rules provided by this lexicon (imported by plugin.ts). */
export const rules: LintRule[] = [noSecretLiteralsRule, preferResourceReferenceRule];
