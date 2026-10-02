/**
 * GRAF112: An alert rule queries a datasource the build does not declare, or of another type
 *
 * Each alert rule query's datasourceUid must be a datasource the build declares: a Datasource it provisions or an ExternalDatasource that already exists in Grafana. A query whose model states a datasource type (model.datasource.type) must match the declared type, and a recording rule's targetDatasourceUid must be a declared Prometheus datasource. With no datasource declared at all, it warns once that it cannot check.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { grafanaDiagnostics } from "./grafana-helpers";

export const graf112: PostSynthCheck = {
  id: "GRAF112",
  description: "An alert rule queries a datasource the build does not declare, or of another type",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return grafanaDiagnostics(ctx, "GRAF112");
  },
};
