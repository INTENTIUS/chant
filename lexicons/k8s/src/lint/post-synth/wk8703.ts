/**
 * WK8703: an AlertmanagerConfig that no Alertmanager selects
 *
 * An Alertmanager merges the AlertmanagerConfigs whose labels match its `alertmanagerConfigSelector` in the
 * namespaces its `alertmanagerConfigNamespaceSelector` picks. One neither selects is accepted and then
 * never routes an alert.
 *
 * Selection is worked out from the manifests in one build root (chant #1939),
 * by the operator's rules: a null object selector matches nothing, `{}`
 * matches all; a null namespace selector matches only the selecting resource's
 * own namespace, `{}` every namespace. Silent when the build has no Alertmanager, since the
 * stack is often installed separately. A selector on a namespace label the
 * build cannot read (the Namespace is not declared in it) counts as selecting.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { describe, monitoringKind, nameOf, selectionContext, unselected } from "./monitoring-selection-helpers";

export const wk8703: PostSynthCheck = {
  id: "WK8703",
  description:
    "An AlertmanagerConfig that no Alertmanager in the build selects through alertmanagerConfigSelector and alertmanagerConfigNamespaceSelector never routes an alert. A null selector matches nothing, {} matches all. Silent when the build has no Alertmanager.",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const sc = selectionContext(ctx);
    const configs = monitoringKind(sc.manifests, "AlertmanagerConfig");
    return unselected(sc, configs, monitoringKind(sc.manifests, "Alertmanager"), () => ["alertmanagerConfigSelector", "alertmanagerConfigNamespaceSelector"]).map((c) => ({
      checkId: "WK8703",
      severity: "warning",
      message:
        `${describe(c)} is selected by no Alertmanager in this build, so its routes and receivers are never used. ` +
        `Match its labels (and namespace) with alertmanagerConfigSelector and alertmanagerConfigNamespaceSelector: null selects nothing, {} selects all.`,
      entity: nameOf(c),
      lexicon: "k8s",
    }));
  },
};
