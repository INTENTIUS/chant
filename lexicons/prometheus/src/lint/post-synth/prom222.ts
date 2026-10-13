/**
 * PROM222: Credentials sent to an http:// receiver URL
 *
 * An integration whose URL is http:// and whose request carries a credential:
 * user info in the URL, http_config auth, or a key or token field.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { alertmanagerDiagnostics } from "./prom-helpers";

export const prom222: PostSynthCheck = {
  id: "PROM222",
  description: "Credentials sent to an http:// receiver URL",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return alertmanagerDiagnostics(ctx, "PROM222");
  },
};
