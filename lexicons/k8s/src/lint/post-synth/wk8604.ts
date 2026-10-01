/**
 * WK8604: the otel config checks over collector configs in ConfigMaps
 *
 * `OtelCollector`, `OtelCollectorGateway`, `GkeOtelCollector` and hand-written
 * manifests carry the collector config as a string under a ConfigMap data key.
 * `chant build` gives each lexicon's checks only that lexicon's output, so the
 * otel lexicon's config checks never see a config that lives in the k8s output
 * (chant #2930). This check runs them there: every ConfigMap data value that
 * parses as a collector config (a `service.pipelines` map) goes through the
 * otel lexicon's `validateCollectorConfig`.
 *
 * Findings keep the otel rule ids (OTEL101-OTEL106, OTEL112, OTEL116, and any config
 * check the otel lexicon adds later), so `lint.rules` and suppressions name
 * one id wherever the config lives. Each message names the ConfigMap's
 * namespace, name and key. Needs only the k8s lexicon in the project.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { collectorConfigDiagnostics } from "@intentius/chant-lexicon-otel/lint/post-synth/otel-helpers";

export const wk8604: PostSynthCheck = {
  id: "WK8604",
  description:
    "OpenTelemetry Collector config in a ConfigMap fails the otel lexicon's config checks; findings are reported under their OTEL1xx ids, naming the ConfigMap and key.",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return collectorConfigDiagnostics(ctx, { configMapsOnly: true });
  },
};
