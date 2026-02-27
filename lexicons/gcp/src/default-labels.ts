/**
 * Default Labels & Annotations — declares project-wide labels/annotations
 * for all GCP Config Connector resources.
 *
 * When a project exports a `defaultLabels(...)` or `defaultAnnotations(...)`
 * declaration, the serializer automatically injects them into every resource's
 * metadata at synthesis time. Explicit labels/annotations on individual
 * resources take precedence.
 */

import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";

export const DEFAULT_LABELS_MARKER = Symbol.for("chant.gcp.defaultLabels");
export const DEFAULT_ANNOTATIONS_MARKER = Symbol.for("chant.gcp.defaultAnnotations");

export interface DefaultLabels extends Declarable {
  readonly [DEFAULT_LABELS_MARKER]: true;
  readonly [DECLARABLE_MARKER]: true;
  readonly lexicon: "gcp";
  readonly entityType: "chant:gcp:defaultLabels";
  readonly labels: Record<string, unknown>;
}

export interface DefaultAnnotations extends Declarable {
  readonly [DEFAULT_ANNOTATIONS_MARKER]: true;
  readonly [DECLARABLE_MARKER]: true;
  readonly lexicon: "gcp";
  readonly entityType: "chant:gcp:defaultAnnotations";
  readonly annotations: Record<string, unknown>;
}

export function isDefaultLabels(value: unknown): value is DefaultLabels {
  return (
    typeof value === "object" &&
    value !== null &&
    DEFAULT_LABELS_MARKER in value &&
    (value as Record<symbol, unknown>)[DEFAULT_LABELS_MARKER] === true
  );
}

export function isDefaultAnnotations(value: unknown): value is DefaultAnnotations {
  return (
    typeof value === "object" &&
    value !== null &&
    DEFAULT_ANNOTATIONS_MARKER in value &&
    (value as Record<symbol, unknown>)[DEFAULT_ANNOTATIONS_MARKER] === true
  );
}

/**
 * Declare project-wide default labels for all GCP Config Connector resources.
 *
 * @example
 * ```ts
 * import { defaultLabels } from "@intentius/chant-lexicon-gcp";
 *
 * export const labels = defaultLabels({
 *   "app.kubernetes.io/managed-by": "chant",
 *   "env": "production",
 * });
 * ```
 */
export function defaultLabels(labels: Record<string, unknown>): DefaultLabels {
  return {
    [DEFAULT_LABELS_MARKER]: true,
    [DECLARABLE_MARKER]: true,
    lexicon: "gcp",
    entityType: "chant:gcp:defaultLabels",
    labels,
  };
}

/**
 * Declare project-wide default annotations for all GCP Config Connector resources.
 *
 * @example
 * ```ts
 * import { defaultAnnotations, GCP } from "@intentius/chant-lexicon-gcp";
 *
 * export const annotations = defaultAnnotations({
 *   "cnrm.cloud.google.com/project-id": GCP.ProjectId,
 * });
 * ```
 */
export function defaultAnnotations(annotations: Record<string, unknown>): DefaultAnnotations {
  return {
    [DEFAULT_ANNOTATIONS_MARKER]: true,
    [DECLARABLE_MARKER]: true,
    lexicon: "gcp",
    entityType: "chant:gcp:defaultAnnotations",
    annotations,
  };
}
