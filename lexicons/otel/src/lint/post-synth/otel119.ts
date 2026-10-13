/**
 * OTEL119: A collector config sets a field deprecated at or before the pinned release
 *
 * `invert_match: true` in a `tail_sampling` policy (inverted decisions are deprecated in collector-contrib v0.126.0 for a `drop` policy), `service.telemetry.metrics.address` (deprecated in collector v0.111.0 for `readers`), and `dimensions_cache_size` on `spanmetrics` (deprecated in collector-contrib v0.125.0 for `aggregation_cardinality_limit`). The collector still reads each at v0.130.0, and a later release drops it.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { configDiagnostics } from "./otel-helpers";

export const otel119: PostSynthCheck = {
  id: "OTEL119",
  description: "A collector config sets a field deprecated at or before the pinned release",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return configDiagnostics(ctx, "OTEL119");
  },
};
