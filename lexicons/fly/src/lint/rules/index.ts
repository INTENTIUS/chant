import type { LintRule } from "@intentius/chant/lint/rule";
import { validRegionRule } from "./valid-region";
import { guestSizingRule } from "./guest-sizing";
import { noSecretLiteralsRule } from "./no-secret-literals";

export { validRegionRule } from "./valid-region";
export { guestSizingRule } from "./guest-sizing";
export { noSecretLiteralsRule } from "./no-secret-literals";

/** All lint rules provided by the fly lexicon. */
export const rules: LintRule[] = [
  validRegionRule,
  guestSizingRule,
  noSecretLiteralsRule,
];
