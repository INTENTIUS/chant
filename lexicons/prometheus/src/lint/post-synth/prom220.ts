/**
 * PROM220: A receiver turns off TLS certificate verification
 *
 * tls_config.insecure_skip_verify: true on a receiver, or in global, accepts
 * any certificate the endpoint presents.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { alertmanagerDiagnostics } from "./prom-helpers";

export const prom220: PostSynthCheck = {
  id: "PROM220",
  description: "A receiver turns off TLS certificate verification",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return alertmanagerDiagnostics(ctx, "PROM220");
  },
};
