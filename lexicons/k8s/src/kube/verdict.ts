/**
 * The chant verdict column `chant kube get` carries on every row (chant
 * #1079's acceptance criterion: "get annotates each row with the declared /
 * owned / drifted / foreign-owned verdict").
 *
 * Four states:
 *
 * - `declared` — this project's source names an entity at this exact
 *   apiVersion/kind/name(/namespace), and the live object agrees with it on
 *   every field the source declares.
 * - `drifted` — same match, but the live object disagrees with the source on
 *   at least one declared field.
 * - `owned` — no declared match, but the live object carries chant's
 *   ownership marker (`app.kubernetes.io/managed-by=chant`) — something
 *   chant applied that source no longer declares, or a stack/entity this
 *   project's build didn't resolve.
 * - `foreign-owned` — no declared match and no marker: chant does not
 *   consider this object its own.
 *
 * `unavailable` is not a verdict about the object; it is what every row gets
 * when the project context could not be loaded at all (chant #1079's
 * "degrades gracefully outside a chant project" — `get` and `describe` still
 * work, this column just has nothing to say).
 *
 * The drift check here is a fast, best-effort *declared-subset* comparison —
 * every path the source sets must agree on the live object — not the
 * managed-fields-precise diff `chant lifecycle diff --live --deep` computes
 * (chant #1076). It exists for a table column that must render for dozens of
 * rows in one `get` call; the deep, field-ownership-aware answer stays the
 * lifecycle command's job. A live object can disagree with the source on a
 * field a controller owns (Kubernetes rewriting `spec.replicas` under an
 * HPA, say) and still show `drifted` here — reach for the deep diff before
 * treating this column as a verdict rather than a hint.
 */

import type { K8sObject } from "@intentius/chant-k8s-client";
import { hasOwnershipMarker, LABEL_OWNERSHIP_KEYS } from "@intentius/chant/ownership";
import type { DeclaredMatch } from "./project";

export type KubeVerdict = "declared" | "owned" | "drifted" | "foreign-owned" | "unavailable";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * True when every path `declared` sets is present and equal on `live`.
 * Extra fields on `live` (server defaults, status, anything the source never
 * mentions) are not drift — chant never declared an opinion about them.
 */
export function declaredSubsetMatches(declared: unknown, live: unknown): boolean {
  if (Array.isArray(declared)) {
    if (!Array.isArray(live) || declared.length !== live.length) return false;
    return declared.every((item, i) => declaredSubsetMatches(item, live[i]));
  }
  if (isPlainObject(declared)) {
    if (!isPlainObject(live)) return false;
    return Object.entries(declared).every(([key, value]) => declaredSubsetMatches(value, live[key]));
  }
  return declared === live;
}

/** The declared fields worth comparing — everything but the name/namespace identity itself. */
function declaredComparable(props: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!props) return {};
  const { metadata, ...rest } = props;
  if (!isPlainObject(metadata)) return rest;
  const { name: _name, namespace: _namespace, ...restMetadata } = metadata;
  return { ...rest, ...(Object.keys(restMetadata).length > 0 ? { metadata: restMetadata } : {}) };
}

export function verdictFor(live: K8sObject, match: DeclaredMatch | undefined): KubeVerdict {
  if (match) {
    return declaredSubsetMatches(declaredComparable(match.props), live) ? "declared" : "drifted";
  }
  return hasOwnershipMarker(live.metadata?.labels, LABEL_OWNERSHIP_KEYS) ? "owned" : "foreign-owned";
}
