/**
 * WK8701: a PrometheusRule that no Prometheus or ThanosRuler selects
 *
 * A Prometheus or ThanosRuler runs the rules whose labels match its `ruleSelector` in the namespaces its
 * `ruleNamespaceSelector` picks. A PrometheusRule neither selects is accepted by the API server and then
 * never evaluated: no error, no alert.
 *
 * Selection is worked out from the manifests in one build root (chant #1939),
 * by the operator's rules: a null object selector matches nothing, `{}`
 * matches all; a null namespace selector matches only the selecting resource's
 * own namespace, `{}` every namespace. Silent when the build has no Prometheus or ThanosRuler, since the
 * stack is often installed separately. A selector on a namespace label the
 * build cannot read (the Namespace is not declared in it) counts as selecting.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { describe, monitoringKind, nameOf, selectionContext, unselected } from "./monitoring-selection-helpers";

export const wk8701: PostSynthCheck = {
  id: "WK8701",
  description:
    "A PrometheusRule that no Prometheus or ThanosRuler in the build selects through ruleSelector and ruleNamespaceSelector is never evaluated. A null selector matches nothing, {} matches all. Silent when the build has no Prometheus or ThanosRuler.",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const sc = selectionContext(ctx);
    const selectors = [...monitoringKind(sc.manifests, "Prometheus"), ...monitoringKind(sc.manifests, "ThanosRuler")];
    return unselected(sc, monitoringKind(sc.manifests, "PrometheusRule"), selectors, () => ["ruleSelector", "ruleNamespaceSelector"]).map((r) => ({
      checkId: "WK8701",
      severity: "warning",
      message:
        `${describe(r)} is selected by no Prometheus or ThanosRuler in this build, so the operator never loads it and its rules are never evaluated. ` +
        `Match its labels (and namespace) with ruleSelector and ruleNamespaceSelector: null selects nothing, {} selects all.`,
      entity: nameOf(r),
      lexicon: "k8s",
    }));
  },
};
