import type { LintRule } from "@intentius/chant/lint/rule";
import { validRegionRule } from "./valid-region";
import { noSecretLiteralsRule } from "./no-secret-literals";
import { validCronScheduleRule } from "./valid-cron-schedule";

export { validRegionRule } from "./valid-region";
export { noSecretLiteralsRule } from "./no-secret-literals";
export { validCronScheduleRule, isValidCronSchedule } from "./valid-cron-schedule";

/** All lint rules provided by the render lexicon. */
export const rules: LintRule[] = [validRegionRule, noSecretLiteralsRule, validCronScheduleRule];
