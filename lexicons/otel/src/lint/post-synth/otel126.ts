/**
 * OTEL126: k8sattributes extracts a metadata field it does not support
 *
 * Each name in a `k8sattributes` processor's `extract.metadata` must be one `Config.Validate` accepts at collector-contrib v0.130.0 (`K8S_ATTRIBUTES_METADATA`); the collector refuses any other.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { configDiagnostics } from "./otel-helpers";

export const otel126: PostSynthCheck = {
  id: "OTEL126",
  description: "k8sattributes extracts a metadata field it does not support",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return configDiagnostics(ctx, "OTEL126");
  },
};
