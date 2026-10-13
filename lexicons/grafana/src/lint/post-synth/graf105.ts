/**
 * GRAF105: A panel does not fit the 24-column grid, or overlaps another panel
 *
 * A panel wider than the grid is an error. An overlap is a warning: Grafana moves one of the panels on load, so the dashboard does not look the way it was declared. Panels without x and y are placed by the dashboard and cannot overlap each other.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { grafanaDiagnostics } from "./grafana-helpers";

export const graf105: PostSynthCheck = {
  id: "GRAF105",
  description: "A panel does not fit the 24-column grid, or overlaps another panel",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return grafanaDiagnostics(ctx, "GRAF105");
  },
};
