/**
 * GRAF106: A dashboard or datasource uid Grafana rejects, or a dashboard with no title
 *
 * Grafana accepts uids of 1-40 letters, digits, - and _, and refuses to save a dashboard without a title.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { grafanaDiagnostics } from "./grafana-helpers";

export const graf106: PostSynthCheck = {
  id: "GRAF106",
  description: "A dashboard or datasource uid Grafana rejects, or a dashboard with no title",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return grafanaDiagnostics(ctx, "GRAF106");
  },
};
