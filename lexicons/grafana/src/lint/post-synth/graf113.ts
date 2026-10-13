/**
 * GRAF113: Alerting routes to a contact point or mute timing the build does not declare, or a policy matcher does not parse
 *
 * The notification policy tree's receivers, every rule's notification_settings.receiver, and each mute_time_intervals and active_time_intervals entry must name a ContactPoint or MuteTiming the build declares (grafana-default-email exists in every Grafana). Policy object_matchers must be [label, op, value] with op =, !=, =~ or !~ and a valid regex; matchers must parse as Alertmanager matchers. With no contact point or mute timing declared it warns once that it cannot check.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { grafanaDiagnostics } from "./grafana-helpers";

export const graf113: PostSynthCheck = {
  id: "GRAF113",
  description: "Alerting routes to a contact point or mute timing the build does not declare, or a policy matcher does not parse",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return grafanaDiagnostics(ctx, "GRAF113");
  },
};
