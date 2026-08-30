/**
 * Model composite — resolves a model artifact reference to a KServe
 * `storageUri` (+ optional warm-cache PVC), keyed by `(id, version)`.
 *
 * This is the FSx-warm-cache equivalent from the Netflix serving yardstick
 * (see epic #982): a small, spec-true resolver that InferenceService (#985)
 * consumes for its predictor's model reference. It does not itself emit an
 * InferenceService or ServingRuntime — those are #984/#985's job.
 *
 * `version` is required so every resolved `storageUri` is pinned: the
 * version is always appended as the trailing path segment, whether the
 * default `id`-derived path is used or `uri` overrides it. This keeps the
 * output stable for the unpinned-model lint rule (#988).
 *
 * `Model` itself is a plain resolver — a resolved value object, per the
 * composite conventions — rather than a `Composite`, because its primary
 * output (`storageUri`) is a string, not a Declarable; a `Composite`
 * factory's members must all be Declarables. The optional cache PVC is
 * built through an internal `Composite` so it gets the same bookkeeping
 * (provenance, defaults-merging) as every other emitted resource.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { PersistentVolumeClaim } from "../generated";

/** Where the model's weights live. Maps to the matching KServe storage-initializer scheme. */
export type ModelSource = "hf" | "gcs" | "s3" | "pvc";

const STORAGE_SCHEME: Record<ModelSource, string> = {
  hf: "hf",
  gcs: "gs",
  s3: "s3",
  pvc: "pvc",
};

export interface ModelProps {
  /** Model identifier, e.g. "llama-3-8b-instruct". Used to key the resolved storageUri and cache PVC. */
  id: string;
  /**
   * Model version/revision. REQUIRED — feeds the unpinned-model lint rule
   * (#988). Always appears as the trailing segment of the resolved
   * `storageUri` so the reference is pinned.
   */
  version: string;
  /** Where the model artifact is hosted; selects the storageUri scheme. */
  source: ModelSource;
  /**
   * Explicit path override (e.g. a bucket/prefix, HF repo id, or PVC name)
   * in place of the `id`-derived default. `version` is still appended.
   */
  uri?: string;
  /** When set, emits a warm-cache PVC named `${id}-${version}` for the InferenceService (#985) to mount. */
  cache?: {
    storageClass: string;
    size: string;
  };
  /** Per-member defaults for fine-grained overrides. */
  defaults?: {
    cachePvc?: Partial<Record<string, unknown>>;
  };
}

export interface ModelResult {
  /** Resolved KServe storageUri, pinned to `version`. */
  storageUri: string;
  /** Warm-cache PVC, present only when `cache` is set. Named `${id}-${version}`. */
  cache?: InstanceType<typeof PersistentVolumeClaim>;
}

/**
 * Resolve a model artifact's `{ id, version, source, uri }` to a pinned
 * KServe `storageUri` string.
 */
export function resolveModelStorageUri(props: Pick<ModelProps, "id" | "version" | "source" | "uri">): string {
  const { id, version, source, uri } = props;
  const scheme = STORAGE_SCHEME[source];
  const path = uri ?? id;
  return `${scheme}://${path}/${version}`;
}

interface ModelCachePvcProps {
  id: string;
  version: string;
  storageClass: string;
  size: string;
  defaults?: Partial<Record<string, unknown>>;
}

const ModelCachePvc = Composite<ModelCachePvcProps, { pvc: InstanceType<typeof PersistentVolumeClaim> }>(
  (props) => {
    const { id, version, storageClass, size, defaults } = props;

    const pvc = new PersistentVolumeClaim(mergeDefaults({
      metadata: {
        name: `${id}-${version}`,
        labels: {
          "app.kubernetes.io/name": id,
          "app.kubernetes.io/managed-by": "chant",
          "app.kubernetes.io/component": "model-cache",
        },
      },
      spec: {
        accessModes: ["ReadWriteMany"],
        storageClassName: storageClass,
        resources: { requests: { storage: size } },
      },
    }, defaults));

    return { pvc };
  },
  "ModelCachePvc",
);

/**
 * Resolve a model artifact `{ id, version, source, uri, cache }` to a pinned
 * `storageUri`, with an optional warm-cache PVC.
 *
 * @example
 * ```ts
 * import { Model } from "@intentius/chant-lexicon-k8s";
 *
 * const { storageUri, cache } = Model({
 *   id: "llama-3-8b-instruct",
 *   version: "2024-07-01",
 *   source: "gcs",
 *   uri: "my-models-bucket/llama-3-8b-instruct",
 *   cache: { storageClass: "premium-rwo", size: "200Gi" },
 * });
 * ```
 */
export function Model(props: ModelProps): ModelResult {
  const { id, version, cache, defaults } = props;

  const storageUri = resolveModelStorageUri(props);

  const cachePvc = cache
    ? ModelCachePvc({
        id,
        version,
        storageClass: cache.storageClass,
        size: cache.size,
        defaults: defaults?.cachePvc,
      }).pvc
    : undefined;

  return {
    storageUri,
    ...(cachePvc && { cache: cachePvc }),
  };
}
