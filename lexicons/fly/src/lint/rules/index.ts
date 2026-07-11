import type { LintRule } from "@intentius/chant/lint/rule";
import { sampleRule } from "./sample";

export { sampleRule } from "./sample";

/** All lint rules provided by the fly lexicon. */
export const rules: LintRule[] = [sampleRule];
