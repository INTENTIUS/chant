/**
 * GRAF104: Two dashboards, datasources, folders, panels, variables or queries share an id
 *
 * Dashboard, folder and datasource uids and datasource names must be unique across the build, panel ids and variable names within a dashboard, and refIds within a panel. Grafana keeps one of two dashboards with the same uid and silently drops the other.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { grafanaDiagnostics } from "./grafana-helpers";

export const graf104: PostSynthCheck = {
  id: "GRAF104",
  description: "Two dashboards, datasources, folders, panels, variables or queries share an id",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return grafanaDiagnostics(ctx, "GRAF104");
  },
};
