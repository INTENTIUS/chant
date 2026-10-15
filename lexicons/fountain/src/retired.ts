/**
 * Kinds Managoat removed (managoat/managoat#2793), kept as stubs so a project
 * that still declares one builds far enough to be told what replaced it.
 *
 * `Teammate`, `Schedule` and `Webhook` were generated from the team, schedule
 * and webhook routes until fountain v0.29.0, the pinned spec, stopped
 * describing them: Managoat removed the team and its schedules (ADR 0074) and
 * webhooks (managoat/fountain#2615), and those routes answer 404. Deleting the
 * exports would turn an old project's first build into a TypeScript import
 * error that says nothing about why. Instead each stays a declarable of its old
 * type, the serializer leaves it out of the manifest, and FTN025 fails the
 * build with the replacement for that kind.
 */

import { createResource } from "@intentius/chant/runtime";

/** What replaced each retired kind, as FTN025 and the docs state it. */
export const RETIRED_KINDS: Record<string, { kind: string; replacement: string }> = {
  "Fountain::V1::Teammate": {
    kind: "Teammate",
    replacement:
      "Managoat has no team. A long-lived thread is one conversation resumed by channel_id " +
      "(chant run <op> --on fountain does this for a Steward), or a sandbox of your own with --on e2b",
  },
  "Fountain::V1::Schedule": {
    kind: "Schedule",
    replacement:
      "Managoat has no scheduler. Drive the cron from outside it: a CI schedule, a CronJob or " +
      "chant operator, running chant run <op> --on fountain or --on e2b",
  },
  "Fountain::V1::Webhook": {
    kind: "Webhook",
    replacement: "Managoat has no webhooks. Read a run's outcome from chant run, or from the conversation's event stream",
  },
};

/**
 * @deprecated Managoat removed the team (ADR 0074). Declaring one fails the
 * build with FTN025. Use a Steward, which `chant run <op> --on fountain` reaches
 * through one long-lived conversation, or `--on e2b`.
 */
export const Teammate = /* @__PURE__ */ createResource("Fountain::V1::Teammate", "fountain", {});

/**
 * @deprecated Managoat has no scheduler (ADR 0074). Declaring one fails the
 * build with FTN025. Run the Op from a clock outside Managoat: a CI schedule, a
 * CronJob or `chant operator`.
 */
export const Schedule = /* @__PURE__ */ createResource("Fountain::V1::Schedule", "fountain", {});

/**
 * @deprecated Managoat removed webhooks. Declaring one fails the build with
 * FTN025.
 */
export const Webhook = /* @__PURE__ */ createResource("Fountain::V1::Webhook", "fountain", {});
