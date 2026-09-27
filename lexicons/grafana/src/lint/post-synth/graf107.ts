/**
 * GRAF107: A dashboard does not match the pinned Grafana schema
 *
 * The dashboard is validated against the dashboard schema at GRAFANA_SCHEMA_PIN, and each panel's options, fieldConfig.defaults.custom and queries against their plugin's schema with required fields relaxed (Grafana fills those in). What fails is a key the schema does not have or a value it does not allow: the edits Grafana would otherwise need on import.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { grafanaDiagnostics } from "./grafana-helpers";

export const graf107: PostSynthCheck = {
  id: "GRAF107",
  description: "A dashboard does not match the pinned Grafana schema",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return grafanaDiagnostics(ctx, "GRAF107");
  },
};
