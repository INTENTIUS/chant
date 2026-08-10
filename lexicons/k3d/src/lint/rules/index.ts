import type { LintRule } from "@intentius/chant/lint/rule";
import { registryProxyPasswordRule } from "./registry-proxy-password";

export { registryProxyPasswordRule } from "./registry-proxy-password";

/** All lint rules provided by this lexicon (imported by plugin.ts's lintRules()). */
export const rules: LintRule[] = [registryProxyPasswordRule];
