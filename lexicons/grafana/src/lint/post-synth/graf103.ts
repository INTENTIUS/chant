/**
 * GRAF103: A query, title, datasource or repeat uses a variable the dashboard does not declare
 *
 * Grafana leaves an undeclared $name in the query as text, so the query fails or matches nothing. Names Grafana defines itself ($__interval, $__rate_interval, $__range and the rest of $__*) need no declaration.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { grafanaDiagnostics } from "./grafana-helpers";

export const graf103: PostSynthCheck = {
  id: "GRAF103",
  description: "A query, title, datasource or repeat uses a variable the dashboard does not declare",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return grafanaDiagnostics(ctx, "GRAF103");
  },
};
