/**
 * GRAF115: A unit Grafana doesn't know
 *
 * Each panel's `fieldConfig.defaults.unit`, every `unit` override, a heatmap's `options.yAxis.unit` and `options.cellValues.unit`, and a legacy graph panel's `yaxes[].format` are looked up in Grafana's unit registry at v13.2.2 (`src/spec/units.gen.ts`). Custom units (`prefix:`, `suffix:`, `time:`, `si:`, `count:`, `currency:`, `bool:`) pass. Anything else Grafana shows as a literal suffix, so it is a warning that names the closest registered id.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { grafanaDiagnostics } from "./grafana-helpers";

export const graf115: PostSynthCheck = {
  id: "GRAF115",
  description: "A panel unit Grafana doesn't know, which it shows as a literal suffix",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return grafanaDiagnostics(ctx, "GRAF115");
  },
};
