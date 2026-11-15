/**
 * Shared helpers for Kubernetes post-synthesis lint rules.
 *
 * Provides the `ctx.docs` → `K8sManifest[]` bridge every check reads through,
 * and container extraction logic that handles all common workload types.
 */

import { parseOutputDocs, type PostSynthContext } from "@intentius/chant/lint/post-synth";
export { getPrimaryOutput, getAdditionalFiles } from "@intentius/chant/lint/post-synth";

/**
 * A parsed Kubernetes manifest (loosely typed).
 */
export interface K8sManifest {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    [key: string]: unknown;
  };
  spec?: Record<string, unknown>;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * A Kubernetes container spec (loosely typed).
 */
export interface K8sContainer {
  name?: string;
  image?: string;
  env?: Array<{ name?: string; value?: unknown; valueFrom?: unknown }>;
  ports?: Array<{ name?: string; containerPort?: number; [key: string]: unknown }>;
  resources?: {
    limits?: Record<string, unknown>;
    requests?: Record<string, unknown>;
  };
  securityContext?: Record<string, unknown>;
  livenessProbe?: unknown;
  readinessProbe?: unknown;
  imagePullPolicy?: string;
  [key: string]: unknown;
}

/**
 * Every parsed Kubernetes manifest across all lexicon outputs, via `ctx.docs`
 * (chant #975) — the shared, parse-once view every k8s post-synth check
 * reads, in place of the old per-check `parseK8sManifests(getPrimaryOutput(output))`
 * splitter (chant #976). Two documents are dropped rather than passed through
 * as a "manifest":
 *
 * - `d.error` — a document `parseOutputDocs` could not make sense of.
 * - `d.file` — a document that came from a `SerializerResult.files` sidecar
 *   (a committed-encrypted secret's ciphertext, in this lexicon) rather than
 *   a lexicon's primary output. `parseK8sManifests` only ever saw
 *   `getPrimaryOutput(output)`, so a sidecar was invisible to every general
 *   manifest-consuming check — see `getAdditionalFiles`'s doc comment on why
 *   that separation is deliberate. Only `sops-helpers.ts`'s
 *   `resolveEncryptedSecretClaims` (WK8504/WK8503's producer join) reads
 *   `.files` explicitly; this bridge must keep it that way.
 *
 * `ctx.docs` is populated by every context chant itself builds (`chant
 * build`, `@intentius/chant-test-utils`'s `createPostSynthContext` /
 * `makePostSynthCtx*`) — see `PostSynthContext.docs`'s doc comment for why
 * it is still optional at the type level. A handful of this lexicon's own
 * hand-rolled `PostSynthContext` test literals (`post-synth.test.ts`'s
 * `makeCtx`) predate that field and never set it; for those, fall back to
 * parsing `ctx.outputs` directly with the same `parseOutputDocs` primitive,
 * rather than silently returning no manifests.
 */
export function docsToManifests(ctx: PostSynthContext): K8sManifest[] {
  const docs = ctx.docs ?? parseOutputDocs(ctx.outputs);
  return docs
    .filter((d) => !d.error && !d.file)
    .map((d) => d.value as K8sManifest);
}

/**
 * What a `metadata.name` that is not a string is, in words a finding can use.
 * Undefined when the name is absent or a string.
 *
 * The usual cause is a template placeholder: `name: {{name}}` is a YAML flow
 * mapping whose key is another mapping, so the parser hands back a map whose
 * only key is the stringified inner map. A shell script or a templating step
 * fills those files in; the file is not a manifest until it has run.
 */
export function describeNonStringName(manifest: { metadata?: { name?: unknown } }): string | undefined {
  const name = manifest.metadata?.name;
  if (name === undefined || name === null || typeof name === "string") return undefined;
  if (Array.isArray(name)) return "a list";
  if (typeof name === "object") {
    const keys = Object.keys(name);
    if (keys.length === 1 && keys[0] === "[object Object]") {
      return "a map, which is what YAML makes of a {{placeholder}}";
    }
    const shown = keys.slice(0, 3).map((k) => JSON.stringify(k)).join(", ");
    return keys.length === 0 ? "an empty map" : `a map with the key${keys.length > 1 ? "s" : ""} ${shown}${keys.length > 3 ? ", ..." : ""}`;
  }
  return `${typeof name} ${String(name)}`;
}

/**
 * The name a diagnostic prints and uses as its `entity`: `metadata.name` when
 * it is a string, otherwise `fallback`. A name that is a map or a list would
 * print as `[object Object]` and break the report's string `entity`, so it
 * never gets through; {@link describeNonStringName} says what it was.
 */
export function nameOf<F extends string | undefined>(manifest: { metadata?: { name?: unknown } }, fallback: F): string | F {
  const name = manifest.metadata?.name;
  if (typeof name === "string") return name;
  if (typeof name === "number" || typeof name === "boolean") return String(name);
  return fallback;
}

/**
 * Extract the pod spec from any workload manifest.
 *
 * Handles:
 * - Pod: spec directly
 * - Deployment, StatefulSet, DaemonSet: spec.template.spec
 * - Job: spec.template.spec
 * - CronJob: spec.jobTemplate.spec.template.spec
 */
export function extractPodSpec(
  manifest: K8sManifest,
): Record<string, unknown> | null {
  const kind = manifest.kind;
  const spec = manifest.spec;
  if (!spec) return null;

  switch (kind) {
    case "Pod":
      return spec as Record<string, unknown>;

    case "Deployment":
    case "StatefulSet":
    case "DaemonSet":
    case "Job": {
      const template = spec.template as Record<string, unknown> | undefined;
      return (template?.spec as Record<string, unknown>) ?? null;
    }

    case "CronJob": {
      const jobTemplate = spec.jobTemplate as Record<string, unknown> | undefined;
      const jobSpec = jobTemplate?.spec as Record<string, unknown> | undefined;
      const template = jobSpec?.template as Record<string, unknown> | undefined;
      return (template?.spec as Record<string, unknown>) ?? null;
    }

    // KServe ServingRuntime/ClusterServingRuntime carry `containers` and
    // `tolerations` directly on spec — no template wrapper, unlike the
    // built-in workload kinds above.
    case "ServingRuntime":
    case "ClusterServingRuntime":
      return spec;

    default:
      return null;
  }
}

/** Where each container extracted by {@link extractContainers} sits in its pod spec, e.g. `containers[1]`. */
const containerPaths = new WeakMap<object, string>();

/**
 * Extract all containers (including init containers) from a workload manifest.
 */
export function extractContainers(manifest: K8sManifest): K8sContainer[] {
  const podSpec = extractPodSpec(manifest);
  if (!podSpec) return [];

  const containers: K8sContainer[] = [];

  for (const field of ["containers", "initContainers"] as const) {
    const list = podSpec[field];
    if (!Array.isArray(list)) continue;
    list.forEach((c, i) => {
      if (typeof c === "object" && c !== null) {
        containerPaths.set(c, `${field}[${i}]`);
        containers.push(c as K8sContainer);
      }
    });
  }

  return containers;
}

/**
 * The place of a container in its workload, `<kind>/<field>[<index>]`, for a
 * diagnostic's `locator`. It names the position, not the container, so a
 * finding keeps its audit identity when the container is renamed. Pass a
 * container that {@link extractContainers} returned.
 */
export function containerLocator(manifest: K8sManifest, container: K8sContainer): string {
  return `${manifest.kind ?? ""}/${containerPaths.get(container) ?? "containers"}`;
}

/**
 * Workload kinds that contain pod templates.
 */
export const WORKLOAD_KINDS = new Set([
  "Pod",
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "Job",
  "CronJob",
]);

/**
 * Workload kinds that can request `nvidia.com/gpu` — the built-in workload
 * kinds plus KServe's ServingRuntime/ClusterServingRuntime, which declare
 * `containers`/`tolerations` directly on spec (see `extractPodSpec`).
 */
export const GPU_POD_KINDS = new Set([
  ...WORKLOAD_KINDS,
  "ServingRuntime",
  "ClusterServingRuntime",
]);

/** A Kubernetes toleration (loosely typed). */
export interface K8sToleration {
  key?: string;
  operator?: "Exists" | "Equal";
  value?: string;
  effect?: string;
  [key: string]: unknown;
}

/** Resource name used for GPU requests/limits across the lexicon. */
export const NVIDIA_GPU_RESOURCE = "nvidia.com/gpu";

/**
 * True when any container in `containers` requests or limits
 * `nvidia.com/gpu`.
 */
export function requestsGpu(containers: K8sContainer[]): boolean {
  return containers.some((c) => {
    const requests = c.resources?.requests as Record<string, unknown> | undefined;
    const limits = c.resources?.limits as Record<string, unknown> | undefined;
    return Boolean(requests?.[NVIDIA_GPU_RESOURCE]) || Boolean(limits?.[NVIDIA_GPU_RESOURCE]);
  });
}

/**
 * True when `tolerations` includes one that tolerates the `nvidia.com/gpu`
 * taint — either an explicit `key: "nvidia.com/gpu"` toleration, or a
 * wildcard `{ operator: "Exists" }` with no key (tolerates every taint).
 */
export function toleratesGpu(tolerations: unknown): boolean {
  if (!Array.isArray(tolerations)) return false;
  return (tolerations as K8sToleration[]).some(
    (t) => t.key === NVIDIA_GPU_RESOURCE || (t.operator === "Exists" && !t.key),
  );
}

/**
 * Parse a Kubernetes memory string to bytes.
 *
 * Handles binary suffixes (Ki, Mi, Gi, Ti) and SI suffixes (K, M, G, T).
 * Returns NaN for unrecognised strings — callers should skip checks on NaN.
 *
 * @example
 * parseMemoryBytes("4Gi")  // 4294967296
 * parseMemoryBytes("512Mi") // 536870912
 * parseMemoryBytes("2048") // 2048
 */
export function parseMemoryBytes(s: string): number {
  const m = /^([0-9]+(?:\.[0-9]+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(s.trim());
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  const multipliers: Record<string, number> = {
    Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4,
    K: 1000, M: 1000 ** 2, G: 1000 ** 3, T: 1000 ** 4,
  };
  return n * (multipliers[m[2] ?? ""] ?? 1);
}

/**
 * Extract the Ray version from an image tag.
 *
 * Looks for a semver-style version prefix in the image tag:
 *   "rayproject/ray:2.40.0"          → "2.40.0"
 *   "rayproject/ray:2.40.0-py310"    → "2.40.0"
 *   "us-docker.pkg.dev/.../ray:2.9.3-gpu" → "2.9.3"
 *   "rayproject/ray:latest"          → undefined
 *
 * Returns undefined when no version can be found.
 */
export function extractRayVersion(image: string): string | undefined {
  const tag = image.includes(":") ? image.split(":").pop()! : image;
  const m = /^([0-9]+\.[0-9]+\.[0-9]+)/.exec(tag);
  return m ? m[1] : undefined;
}
