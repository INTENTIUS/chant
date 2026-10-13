/**
 * WK8606: the prometheus rule checks over PrometheusRule groups
 *
 * `PrometheusRule.spec.groups` is a rule file's `groups`. `chant build` gives
 * each lexicon's checks only that lexicon's output, so the prometheus
 * lexicon's PROM checks never see a rule that lives in the k8s output. This
 * check runs them there: every PrometheusRule's groups go through the
 * prometheus lexicon's rule-file checks (PROM101-PROM107, PROM211,
 * PROM213-PROM219; PROM212 stays opt-in).
 *
 * Findings keep the PROM ids, so `lint.rules` and suppressions name one id
 * wherever the rules live. Each message names the PrometheusRule's namespace
 * and name. Needs only the k8s lexicon in the project.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { prometheusRuleDiagnostics } from "@intentius/chant-lexicon-prometheus/lint/post-synth/prom-helpers";

export const wk8606: PostSynthCheck = {
  id: "WK8606",
  description:
    "A PrometheusRule's groups fail the prometheus lexicon's rule-file checks; findings are reported under their PROM ids, naming the PrometheusRule.",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return prometheusRuleDiagnostics(ctx);
  },
};
