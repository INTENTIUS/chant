/**
 * PROM215: rate, irate or increase over a name that is not a counter's
 *
 * These functions treat every drop as a counter reset. A name not ending in
 * _total, _count, _sum or _bucket is read as a gauge.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { ruleFileDiagnostics } from "./prom-helpers";

export const prom215: PostSynthCheck = {
  id: "PROM215",
  description: "rate, irate or increase over a name that is not a counter's",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return ruleFileDiagnostics(ctx, "PROM215");
  },
};
