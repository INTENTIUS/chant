/**
 * PROM221: SMTP credentials sent with require_tls false
 *
 * An email receiver with SMTP auth and require_tls false (its own, or
 * global.smtp_require_tls) can send the credentials in clear text. Implicit
 * TLS is left alone.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { alertmanagerDiagnostics } from "./prom-helpers";

export const prom221: PostSynthCheck = {
  id: "PROM221",
  description: "SMTP credentials sent with require_tls false",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return alertmanagerDiagnostics(ctx, "PROM221");
  },
};
