/**
 * PROM208: An Alertmanager duration is not a duration
 *
 * group_wait, group_interval, repeat_interval, resolve_timeout and Jira reopen_duration take Prometheus durations (30s, 4h, 1d); the timeout of webhook, Slack, PagerDuty and incident.io, and Pushover retry, expire and ttl take Go durations (10s, 1m30s, 500ms).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { alertmanagerDiagnostics } from "./prom-helpers";

export const prom208: PostSynthCheck = {
  id: "PROM208",
  description: "An Alertmanager duration is not a duration",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return alertmanagerDiagnostics(ctx, "PROM208");
  },
};
