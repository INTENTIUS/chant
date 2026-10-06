/**
 * WK8604: the otel config checks over collector configs in ConfigMaps
 *
 * `OtelCollector`, `OtelCollectorGateway`, `GkeOtelCollector` and hand-written
 * manifests carry the collector config as a string under a ConfigMap data key.
 * `chant build` gives each lexicon's checks only that lexicon's output, so the
 * otel lexicon's config checks never see a config that lives in the k8s output
 * (chant #2930). This check runs them there: every ConfigMap data value that
 * parses as a collector config (a `service.pipelines` map) goes through the
 * otel lexicon's `validateCollectorConfig`, and through `attributionIssues`
 * (OTEL118) when the build stamps telemetry attribution.
 *
 * An OpenTelemetry Operator `OpenTelemetryCollector` carries its config in
 * `spec.config` (an object in v1beta1, YAML text in v1alpha1), and goes
 * through the same checks; its findings name `OpenTelemetryCollector
 * <namespace>/<name>, spec.config` where a ConfigMap's name the ConfigMap and
 * key (#3367).
 *
 * Findings keep the otel rule ids (OTEL101-OTEL106, OTEL112-OTEL127, and any config
 * check the otel lexicon adds later), so `lint.rules` and suppressions name
 * one id wherever the config lives. Each message names the ConfigMap's
 * namespace, name and key. Needs only the k8s lexicon in the project.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { collectorConfigDiagnostics } from "@intentius/chant-lexicon-otel/lint/post-synth/otel-helpers";

export const wk8604: PostSynthCheck = {
  id: "WK8604",
  description:
    "OpenTelemetry Collector config in a ConfigMap or an OpenTelemetryCollector's spec.config fails the otel lexicon's config checks; findings are reported under their OTEL1xx ids, naming the ConfigMap and key, or the OpenTelemetryCollector.",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return collectorConfigDiagnostics(ctx, { hostedOnly: true });
  },
};
