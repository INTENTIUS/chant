/**
 * PROM105: A rule or group is malformed
 *
 * A rule sets exactly one of record and alert, has a non-empty name, and a recording rule takes no for, keep_firing_for or annotations. A group has a name.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { ruleFileDiagnostics } from "./prom-helpers";

export const prom105: PostSynthCheck = {
  id: "PROM105",
  description: "A rule or group is malformed",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return ruleFileDiagnostics(ctx, "PROM105");
  },
};
