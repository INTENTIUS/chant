/**
 * Default Labels & Annotations — declares project-wide labels/annotations
 * for all Kubernetes resources.
 *
 * When a project exports a `defaultLabels(...)` or `defaultAnnotations(...)`
 * declaration, the serializer automatically injects them into every resource's
 * metadata at synthesis time. Explicit labels/annotations on individual
 * resources take precedence.
 */

import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";

/**
 * Marker symbol for default labels identification.
 */
export const DEFAULT_LABELS_MARKER = Symbol.for("chant.k8s.defaultLabels");

/**
 * Marker symbol for default annotations identification.
 */
export const DEFAULT_ANNOTATIONS_MARKER = Symbol.for("chant.k8s.defaultAnnotations");

/**
 * A default labels declaration — wraps a label map into a Declarable
 * that the serializer uses to inject labels into all resources.
 */
export interface DefaultLabels extends Declarable {
  readonly [DEFAULT_LABELS_MARKER]: true;
  readonly [DECLARABLE_MARKER]: true;
  readonly lexicon: "k8s";
  readonly entityType: "chant:k8s:defaultLabels";
  readonly labels: Record<string, unknown>;
}

/**
 * A default annotations declaration — wraps an annotation map into a Declarable
 * that the serializer uses to inject annotations into all resources.
 */
export interface DefaultAnnotations extends Declarable {
  readonly [DEFAULT_ANNOTATIONS_MARKER]: true;
  readonly [DECLARABLE_MARKER]: true;
  readonly lexicon: "k8s";
  readonly entityType: "chant:k8s:defaultAnnotations";
  readonly annotations: Record<string, unknown>;
}

/**
 * Type guard for DefaultLabels.
 */
export function isDefaultLabels(value: unknown): value is DefaultLabels {
  return (
    typeof value === "object" &&
    value !== null &&
    DEFAULT_LABELS_MARKER in value &&
    (value as Record<symbol, unknown>)[DEFAULT_LABELS_MARKER] === true
  );
}

/**
 * Type guard for DefaultAnnotations.
 */
export function isDefaultAnnotations(value: unknown): value is DefaultAnnotations {
  return (
    typeof value === "object" &&
    value !== null &&
    DEFAULT_ANNOTATIONS_MARKER in value &&
    (value as Record<symbol, unknown>)[DEFAULT_ANNOTATIONS_MARKER] === true
  );
}

/**
 * Declare project-wide default labels for all Kubernetes resources.
 *
 * Labels are injected at synthesis time into every resource's
 * `metadata.labels`. If a resource has an explicit label with the
 * same key, the explicit value wins.
 *
 * @example
 * ```ts
 * import { defaultLabels } from "@intentius/chant-lexicon-k8s";
 *
 * export const labels = defaultLabels({
 *   "app.kubernetes.io/managed-by": "chant",
 *   "app.kubernetes.io/part-of": "my-app",
 * });
 * ```
 */
export function defaultLabels(labels: Record<string, unknown>): DefaultLabels {
  return {
    [DEFAULT_LABELS_MARKER]: true,
    [DECLARABLE_MARKER]: true,
    lexicon: "k8s",
    entityType: "chant:k8s:defaultLabels",
    labels,
  };
}

/**
 * Declare project-wide default annotations for all Kubernetes resources.
 *
 * Annotations are injected at synthesis time into every resource's
 * `metadata.annotations`. If a resource has an explicit annotation with
 * the same key, the explicit value wins.
 *
 * @example
 * ```ts
 * import { defaultAnnotations } from "@intentius/chant-lexicon-k8s";
 *
 * export const annotations = defaultAnnotations({
 *   "app.kubernetes.io/managed-by": "chant",
 * });
 * ```
 */
export function defaultAnnotations(annotations: Record<string, unknown>): DefaultAnnotations {
  return {
    [DEFAULT_ANNOTATIONS_MARKER]: true,
    [DECLARABLE_MARKER]: true,
    lexicon: "k8s",
    entityType: "chant:k8s:defaultAnnotations",
    annotations,
  };
}
