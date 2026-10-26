import type { LintRule } from "@intentius/chant/lint/rule";
import { memberDirAbsoluteRule } from "./member-dir-absolute";

export { memberDirAbsoluteRule } from "./member-dir-absolute";

/** All lint rules provided by this lexicon (imported by plugin.ts's lintRules()). */
export const rules: LintRule[] = [memberDirAbsoluteRule];
