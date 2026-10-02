/**
 * PROM202: An alert severity is not routed by any route
 *
 * Joins the rule files and the Alertmanager config in one build root. An alert whose severity no route below the root matches falls through to the root's default receiver. Silent when the rules and the Alertmanager config are built in different build roots (chant #1939).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { routingDiagnostics } from "./prom-helpers";

export const prom202: PostSynthCheck = {
  id: "PROM202",
  description: "An alert severity is not routed by any route",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return routingDiagnostics(ctx);
  },
};
