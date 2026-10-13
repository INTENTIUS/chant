/**
 * GRAF114: An alerting uid, name, title or interval Grafana rejects, or one declared twice
 *
 * Rule uids and contact point receiver uids must be 1-40 letters, digits, - and _; rules need a title of at most 190 characters; groups need a name, a folder and an interval that is a positive multiple of 10s; for and keepFiringFor must be durations; noDataState and execErrState must be values Grafana knows. A contact point receiver's settings are checked against the options Grafana lists for its integration: a required one left out is an error, and a key the integration does not take is a warning (with the nearest setting named). Integrations the lexicon has no table for are not checked. Rule uids, group names within a folder, contact point names, receiver uids, mute timing and template names must be unique per organisation, and each organisation has one policy tree. Grafana refuses the file otherwise, and one refused file stops it provisioning every alerting file.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { grafanaDiagnostics } from "./grafana-helpers";

export const graf114: PostSynthCheck = {
  id: "GRAF114",
  description: "An alerting uid, name, title or interval Grafana rejects, or one declared twice",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return grafanaDiagnostics(ctx, "GRAF114");
  },
};
