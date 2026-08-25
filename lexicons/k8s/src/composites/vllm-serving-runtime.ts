/**
 * VllmServingRuntime composite — KServe ServingRuntime/ClusterServingRuntime
 * running vLLM.
 *
 * Design rule (chant #982, #984): spec-true, not chant-flavored. Props mirror
 * vLLM's real `vllm serve` CLI args — no generic runtime abstraction. KServe's
 * ServingRuntime CRD is the pluggability seam; this composite types vLLM
 * faithfully on top of it, it doesn't invent a wrapper around it.
 *
 * The model itself is not a prop here — an InferenceService (chant #985)
 * references this runtime and supplies storageUri, which KServe mounts at
 * /mnt/models inside the pod. That's the path this composite passes to
 * `vllm serve`.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import {
  ServingRuntime,
  ClusterServingRuntime,
} from "../generated";

/** Container resource spec. GPU count maps to nvidia.com/gpu requests/limits. */
export interface VllmResourceSpec {
  /** CPU request/limit (e.g. "4", "500m"). */
  cpu?: string;
  /** Memory request/limit (e.g. "16Gi"). */
  memory?: string;
  /** GPU count — adds nvidia.com/gpu to resource requests and limits. */
  gpu?: number;
}

export interface VllmServingRuntimeProps {
  /** ServingRuntime/ClusterServingRuntime name. */
  name: string;
  /** Namespace — required unless clusterScoped is true. */
  namespace?: string;
  /**
   * Emit a cluster-scoped ClusterServingRuntime instead of a namespaced
   * ServingRuntime. Default false.
   */
  clusterScoped?: boolean;
  /** vLLM container image (e.g. "vllm/vllm-openai:v0.7.0"). */
  image: string;

  // ── vLLM args (spec-true to `vllm serve --help`) ──────────────────────
  /** --tensor-parallel-size */
  tensorParallelSize?: number;
  /** --max-model-len */
  maxModelLen?: number;
  /** --dtype */
  dtype?: "auto" | "half" | "float16" | "bfloat16" | "float" | "float32";
  /** --quantization (e.g. "awq", "gptq", "fp8") */
  quantization?: string;
  /** --gpu-memory-utilization (0.0-1.0) */
  gpuMemoryUtilization?: number;
  /** --max-num-seqs */
  maxNumSeqs?: number;

  /** Container resources. gpu maps to nvidia.com/gpu. */
  resources?: VllmResourceSpec;
  /**
   * Additional raw args appended after the typed vLLM flags — escape hatch
   * for anything not yet modeled as a typed prop.
   */
  containerArgs?: string[];
  /**
   * supportedModelFormats entry registered on the runtime. Default
   * `{ name: "vllm", autoSelect: true }`.
   */
  modelFormat?: { name: string; version?: string; autoSelect?: boolean; priority?: number };
  /** Additional labels applied to the resource. */
  labels?: Record<string, string>;
  /** Per-member defaults for fine-grained overrides via mergeDefaults. */
  defaults?: {
    servingRuntime?: Partial<Record<string, unknown>>;
  };
}

export interface VllmServingRuntimeResult {
  servingRuntime: InstanceType<typeof ServingRuntime> | InstanceType<typeof ClusterServingRuntime>;
}

/** Build the container args list, in `vllm serve --help` flag order. */
function buildVllmArgs(props: VllmServingRuntimeProps): string[] {
  const {
    tensorParallelSize,
    maxModelLen,
    dtype,
    quantization,
    gpuMemoryUtilization,
    maxNumSeqs,
    containerArgs = [],
  } = props;

  const args: string[] = [];
  if (tensorParallelSize !== undefined) args.push("--tensor-parallel-size", String(tensorParallelSize));
  if (maxModelLen !== undefined) args.push("--max-model-len", String(maxModelLen));
  if (dtype !== undefined) args.push("--dtype", dtype);
  if (quantization !== undefined) args.push("--quantization", quantization);
  if (gpuMemoryUtilization !== undefined) args.push("--gpu-memory-utilization", String(gpuMemoryUtilization));
  if (maxNumSeqs !== undefined) args.push("--max-num-seqs", String(maxNumSeqs));
  args.push(...containerArgs);
  return args;
}

/** Build container resource requests/limits. GPU count maps to nvidia.com/gpu. */
function buildResources(spec?: VllmResourceSpec): Record<string, unknown> | undefined {
  if (!spec) return undefined;
  const base: Record<string, unknown> = {};
  if (spec.cpu) base.cpu = spec.cpu;
  if (spec.memory) base.memory = spec.memory;
  if (spec.gpu) base["nvidia.com/gpu"] = String(spec.gpu);
  if (Object.keys(base).length === 0) return undefined;
  return { requests: { ...base }, limits: { ...base } };
}

/**
 * Create a VllmServingRuntime composite — a KServe ServingRuntime (or, with
 * `clusterScoped: true`, a ClusterServingRuntime) that runs vLLM's OpenAI-
 * compatible server, with vLLM's own flags surfaced as typed props.
 *
 * @example
 * ```ts
 * import { VllmServingRuntime } from "@intentius/chant-lexicon-k8s";
 *
 * const runtime = VllmServingRuntime({
 *   name: "vllm-runtime",
 *   namespace: "models",
 *   image: "vllm/vllm-openai:v0.7.0",
 *   tensorParallelSize: 2,
 *   maxModelLen: 8192,
 *   dtype: "bfloat16",
 *   gpuMemoryUtilization: 0.9,
 *   resources: { cpu: "8", memory: "32Gi", gpu: 2 },
 * });
 * ```
 */
export const VllmServingRuntime = Composite((props: VllmServingRuntimeProps) => {
  const {
    name,
    namespace,
    clusterScoped = false,
    image,
    modelFormat = { name: "vllm", autoSelect: true },
    labels: extraLabels = {},
    defaults: defs,
  } = props;

  if (!clusterScoped && !namespace) {
    throw new Error(
      `VllmServingRuntime("${name}"): namespace is required unless clusterScoped is true.`,
    );
  }

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    "app.kubernetes.io/component": "vllm-serving-runtime",
    ...extraLabels,
  };

  const resources = buildResources(props.resources);

  const spec: Record<string, unknown> = {
    supportedModelFormats: [modelFormat],
    containers: [
      {
        name: "kserve-container",
        image,
        command: ["vllm", "serve", "/mnt/models"],
        args: buildVllmArgs(props),
        ports: [{ containerPort: 8000, protocol: "TCP", name: "http1" }],
        ...(resources && { resources }),
      },
    ],
  };

  const servingRuntime = clusterScoped
    ? new ClusterServingRuntime(mergeDefaults({
        metadata: {
          name,
          labels: commonLabels,
        },
        spec,
      }, defs?.servingRuntime))
    : new ServingRuntime(mergeDefaults({
        metadata: {
          name,
          namespace,
          labels: commonLabels,
        },
        spec,
      }, defs?.servingRuntime));

  return { servingRuntime };
}, "VllmServingRuntime");
