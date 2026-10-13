/**
 * GRAF110: A panel or row repeats over a variable that cannot give it more than one value
 *
 * Grafana repeats a panel or row once per selected value of a query, custom, datasource or group by variable. Over an ad hoc, constant, interval, textbox or switch variable it shows the panel once and logs an error; over a query, custom or datasource variable with neither multi nor includeAll there is only ever one value. A repeat naming no variable is GRAF103.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { grafanaDiagnostics } from "./grafana-helpers";

export const graf110: PostSynthCheck = {
  id: "GRAF110",
  description: "A panel or row repeats over a variable that cannot give it more than one value",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return grafanaDiagnostics(ctx, "GRAF110");
  },
};
