/**
 * PROM216: histogram_quantile over a series without _bucket, or without le
 *
 * A classic histogram's quantile needs its _bucket series with the le label
 * kept. A native histogram has no _bucket series, so this check does not apply
 * to one.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { ruleFileDiagnostics } from "./prom-helpers";

export const prom216: PostSynthCheck = {
  id: "PROM216",
  description: "histogram_quantile over a series without _bucket, or without le",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return ruleFileDiagnostics(ctx, "PROM216");
  },
};
