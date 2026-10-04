/**
 * OTEL123: A debug exporter at verbosity detailed shares a pipeline with a real exporter
 *
 * `verbosity: detailed` writes every record, attributes and bodies included, to the collector's log. In a pipeline that also sends to a backend, that copies the backend's data, sensitive values included, to wherever the collector's logs go.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { configDiagnostics } from "./otel-helpers";

export const otel123: PostSynthCheck = {
  id: "OTEL123",
  description: "A debug exporter at verbosity detailed shares a pipeline with a real exporter",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return configDiagnostics(ctx, "OTEL123");
  },
};
