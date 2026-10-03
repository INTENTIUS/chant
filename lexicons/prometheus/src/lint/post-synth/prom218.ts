/**
 * PROM218: A regex matcher needs no regex, or is anchored
 *
 * A =~ or !~ with no regex metacharacters is an equality matcher written the
 * slow way. Prometheus anchors every regex, so a leading ^ or trailing $ does
 * nothing.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { ruleFileDiagnostics } from "./prom-helpers";

export const prom218: PostSynthCheck = {
  id: "PROM218",
  description: "A regex matcher needs no regex, or is anchored",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return ruleFileDiagnostics(ctx, "PROM218");
  },
};
