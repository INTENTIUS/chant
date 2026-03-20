/**
 * Default labels for Docker Compose services.
 *
 * Follows the K8s lexicon pattern for defaultLabels/defaultAnnotations.
 * The serializer merges these into every Compose service's labels map.
 */

import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";

export const DEFAULT_LABELS_MARKER = Symbol.for("docker.defaultLabels");
export const DEFAULT_ANNOTATIONS_MARKER = Symbol.for("docker.defaultAnnotations");

export interface DefaultLabels extends Declarable {
  readonly [DEFAULT_LABELS_MARKER]: true;
  readonly props: { labels: Record<string, string> };
}

export interface DefaultAnnotations extends Declarable {
  readonly [DEFAULT_ANNOTATIONS_MARKER]: true;
  readonly props: { annotations: Record<string, string> };
}

export function isDefaultLabels(value: unknown): value is DefaultLabels {
  return (
    typeof value === "object" &&
    value !== null &&
    DEFAULT_LABELS_MARKER in value
  );
}

export function isDefaultAnnotations(value: unknown): value is DefaultAnnotations {
  return (
    typeof value === "object" &&
    value !== null &&
    DEFAULT_ANNOTATIONS_MARKER in value
  );
}

/**
 * Create a DefaultLabels entity that the serializer will merge into all services.
 *
 * @example
 * export const labels = defaultLabels({
 *   "com.example.team": "platform",
 *   "com.example.managed-by": "chant",
 * });
 */
export function defaultLabels(labels: Record<string, string>): DefaultLabels {
  return {
    [DECLARABLE_MARKER]: true,
    [DEFAULT_LABELS_MARKER]: true,
    lexicon: "docker",
    entityType: "Docker::DefaultLabels",
    kind: "resource",
    props: { labels },
  };
}

/**
 * Create a DefaultAnnotations entity.
 * (Not used by Compose directly, but useful for Dockerfile LABEL instructions.)
 */
export function defaultAnnotations(annotations: Record<string, string>): DefaultAnnotations {
  return {
    [DECLARABLE_MARKER]: true,
    [DEFAULT_ANNOTATIONS_MARKER]: true,
    lexicon: "docker",
    entityType: "Docker::DefaultAnnotations",
    kind: "resource",
    props: { annotations },
  };
}
