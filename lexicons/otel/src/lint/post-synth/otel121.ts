/**
 * OTEL121: An exporter sends a credential over plaintext
 *
 * A started exporter sends a credential header (`authorization`, `api-key` and the other OTEL002 keys) or a credential key such as `api_key` or `token` to a non-loopback endpoint that is `http://`, or that has `tls.insecure: true` and isn't `https://`.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { configDiagnostics } from "./otel-helpers";

export const otel121: PostSynthCheck = {
  id: "OTEL121",
  description: "An exporter sends a credential over plaintext",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return configDiagnostics(ctx, "OTEL121");
  },
};
