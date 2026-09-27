/**
 * PROM209: A receiver integration is missing its destination or credential
 *
 * A webhook needs url or url_file, Slack an api_url (or the global one), PagerDuty a routing_key or service_key, and email a to address, a smarthost and a from address (or their global defaults).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { alertmanagerDiagnostics } from "./prom-helpers";

export const prom209: PostSynthCheck = {
  id: "PROM209",
  description: "A receiver integration is missing its destination or credential",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return alertmanagerDiagnostics(ctx, "PROM209");
  },
};
