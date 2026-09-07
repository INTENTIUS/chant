/**
 * Shared CronJob schedule validation (issue #2071 item 4).
 *
 * `OperatorStack` and `CronWorkload` both hand their `schedule` field
 * straight to a k8s `CronJob`, which parses only five fields (minute hour
 * day-of-month month day-of-week). Core's own cron parser
 * (`isValidCronExpression`, `packages/core/src/op/cron.ts`, #2120) is
 * deliberately more permissive: it also accepts the 6-field Quartz form
 * (`second minute hour dom month dow`) that a `ConvergeOp`'s own `schedule`
 * may legitimately carry, since the final word on cron syntax belongs to
 * whichever scheduler runs the string. A k8s CronJob is that scheduler here,
 * and it is stricter than core's parser, so a 6-field `ConvergeOp` schedule
 * reused as-is on a CronJob fails at `kubectl apply`, not at build time.
 *
 * This module gives both composites one place to catch that at construction,
 * reusing core's parser rather than a second copy of it.
 */

import { isValidCronExpression } from "@intentius/chant/op";

/**
 * Validate `schedule` for a k8s CronJob, throwing before a bad value ever
 * reaches `kubectl apply`. `context` names the composite (and host, for
 * `OperatorStack`) so the thrown message reads like the rest of that
 * composite's build-time refusals, e.g. `OperatorStack "chant-operator",
 * host "fountain-observe"` or `CronWorkload "backup"`.
 */
export function validateCronJobSchedule(context: string, schedule: string): void {
  if (!schedule || schedule.trim().length === 0) {
    throw new Error(`${context}: schedule is required. A CronJob with no schedule never ticks.`);
  }

  const fields = schedule.trim().split(/\s+/);

  if (!isValidCronExpression(schedule)) {
    throw new Error(
      `${context}: schedule "${schedule}" is not valid cron syntax. A Kubernetes CronJob takes five fields: minute hour day-of-month month day-of-week.`,
    );
  }

  if (fields.length === 6) {
    throw new Error(
      `${context}: schedule "${schedule}" is 6-field cron. A Kubernetes CronJob takes five fields (minute hour day-of-month month day-of-week) and has no seconds column. ` +
        `A ConvergeOp schedule string in that form must be converted before it reaches a CronJob: drop the leading seconds field and keep the remaining five.`,
    );
  }
}
