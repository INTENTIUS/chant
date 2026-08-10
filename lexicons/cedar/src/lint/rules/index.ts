import type { LintRule } from "@intentius/chant/lint/rule";
import { sampleRule } from "./sample";

export { sampleRule } from "./sample";

/** All lint rules provided by this lexicon (imported by plugin.ts's lintRules()). */
export const rules: LintRule[] = [sampleRule];
