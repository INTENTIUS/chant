/**
 * OTEL120: A component in the collector config holds a literal credential
 *
 * OTEL002's check over the emitted or imported config, with the same key pattern (`authorization`, `api-key`, `api_key`, `token`, `password`, `secret`, `key_pem`, `x-honeycomb-team`). A value containing `${` is a reference the collector expands at start-up, and a key ending in `_file` names a path. This catches what OTEL002 can't see: a config brought in by `chant import`, or one inside a ConfigMap.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { configDiagnostics } from "./otel-helpers";

export const otel120: PostSynthCheck = {
  id: "OTEL120",
  description: "A component in the collector config holds a literal credential",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return configDiagnostics(ctx, "OTEL120");
  },
};
