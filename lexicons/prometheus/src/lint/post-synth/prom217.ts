/**
 * PROM217: A recording rule name is not in level:metric:operations form
 *
 * Prometheus's naming convention for recorded series, e.g.
 * job:http_requests:rate5m.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { ruleFileDiagnostics } from "./prom-helpers";

export const prom217: PostSynthCheck = {
  id: "PROM217",
  description: "A recording rule name is not in level:metric:operations form",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return ruleFileDiagnostics(ctx, "PROM217");
  },
};
