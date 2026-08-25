/**
 * InferenceService composite — KServe `InferenceService` (v1beta1).
 *
 * Spec-true to KServe: the predictor references a `ServingRuntime` by name
 * (the plug seam KServe itself defines — see #984's VllmServingRuntime) and
 * a model `storageUri`, plus the real `ComponentExtensionSpec` autoscaling
 * knobs (`minReplicas`/`maxReplicas`/`scaleTarget`/`scaleMetric`) and
 * `canaryTrafficPercent`. No chant-flavored runtime abstraction is invented;
 * `runtime` is just the `ServingRuntime`/`ClusterServingRuntime` name string
 * KServe's own webhook resolves against `supportedModelFormats`.
 *
 * Coupling note (#984/#986 land in parallel in this same lexicon): this
 * composite does not import either sibling. `runtime` is a plain name
 * string (whatever `VllmServingRuntime` from #984 names its `ServingRuntime`
 * object). `model` accepts either a raw `storageUri` string or a
 * `{ storageUri }`-shaped object — the resolved-value shape `Model` from
 * #986 is expected to return — matched structurally, not by import.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { InferenceService as InferenceServiceResource } from "../generated";

/** Knative concurrency, or a raw HPA metric (cpu/memory/rps). */
export type ScaleMetric = "concurrency" | "cpu" | "memory" | "rps";

/**
 * A resolved model reference. Matches the resolved-value shape the `Model`
 * composite (#986) is expected to return — structurally, not by import.
 */
export interface ModelReference {
  storageUri: string;
}

export interface InferenceServiceProps {
  name: string;
  namespace: string;
  /** A raw `storageUri` (e.g. `"gs://bucket/model"`) or a resolved model ref. */
  model: string | ModelReference;
  /** `ServingRuntime`/`ClusterServingRuntime` name the predictor pins to. */
  runtime: string;
  /**
   * Model format name for KServe's runtime auto-matching (e.g. `"vLLM"`).
   * Optional since `runtime` already pins the ServingRuntime explicitly;
   * set it if the ServingRuntime's `supportedModelFormats` expects it.
   */
  modelFormat?: string;
  /** Minimum predictor replicas. */
  minReplicas?: number;
  /** Maximum predictor replicas. */
  maxReplicas?: number;
  /** Autoscaling target value (e.g. concurrency-per-replica, or CPU/memory/RPS target). */
  scaleTarget?: number;
  /** Which metric `scaleTarget` is measured against. */
  scaleMetric?: ScaleMetric;
  /** Percentage of traffic (0-100) routed to this revision as a canary. */
  canaryTrafficPercent?: number;
  labels?: Record<string, string>;
  defaults?: {
    inferenceService?: Partial<Record<string, unknown>>;
  };
}

export type InferenceServiceResult = {
  inferenceService: InstanceType<typeof InferenceServiceResource>;
};

function resolveStorageUri(model: string | ModelReference): string {
  return typeof model === "string" ? model : model.storageUri;
}

/**
 * Create an InferenceService composite — a KServe `InferenceService`
 * predictor referencing a `ServingRuntime` and a model `storageUri`, with
 * autoscaling bounds and an optional canary traffic split.
 *
 * @example
 * ```ts
 * import { InferenceService } from "@intentius/chant-lexicon-k8s";
 *
 * const svc = InferenceService({
 *   name: "llama-3-8b",
 *   namespace: "serving",
 *   model: "gs://my-models/llama-3-8b/v1",
 *   runtime: "vllm-runtime",
 *   modelFormat: "vLLM",
 *   minReplicas: 1,
 *   maxReplicas: 4,
 *   scaleTarget: 8,
 *   scaleMetric: "concurrency",
 *   canaryTrafficPercent: 10,
 * });
 * ```
 */
export const InferenceService = Composite((props: InferenceServiceProps) => {
  const {
    name,
    namespace,
    model,
    runtime,
    modelFormat,
    minReplicas,
    maxReplicas,
    scaleTarget,
    scaleMetric,
    canaryTrafficPercent,
    labels: extraLabels = {},
    defaults: defs,
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    "app.kubernetes.io/component": "inference-service",
    ...extraLabels,
  };

  const predictor: Record<string, unknown> = {
    model: {
      runtime,
      storageUri: resolveStorageUri(model),
      ...(modelFormat !== undefined && { modelFormat: { name: modelFormat } }),
    },
    ...(minReplicas !== undefined && { minReplicas }),
    ...(maxReplicas !== undefined && { maxReplicas }),
    ...(scaleTarget !== undefined && { scaleTarget }),
    ...(scaleMetric !== undefined && { scaleMetric }),
    ...(canaryTrafficPercent !== undefined && { canaryTrafficPercent }),
  };

  const inferenceService = new InferenceServiceResource(mergeDefaults({
    metadata: {
      name,
      namespace,
      labels: commonLabels,
    },
    spec: { predictor },
  }, defs?.inferenceService));

  return { inferenceService };
}, "InferenceService");
