/**
 * PROM225: A labeldrop or labelkeep relabel step carries a field it does not take
 *
 * Both actions match regex against label names, so source_labels, separator,
 * target_label, modulus and replacement do nothing, and Prometheus rejects the
 * file at load. Reads every prometheus.yml in the output.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { relabelDiagnostics } from "./prom-helpers";

export const prom225: PostSynthCheck = {
  id: "PROM225",
  description: "A labeldrop or labelkeep relabel step carries a field it does not take",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return relabelDiagnostics(ctx);
  },
};
