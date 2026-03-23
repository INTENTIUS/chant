/**
 * Shared helpers for Kubernetes post-synthesis lint rules.
 *
 * Provides YAML parsing for multi-document K8s manifests and container
 * extraction logic that handles all common workload types.
 */

import { parseYAML } from "@intentius/chant/yaml";
export { getPrimaryOutput } from "@intentius/chant/lint/post-synth";

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
 * Split a multi-document YAML string on `---` boundaries and parse each
 * document into a K8sManifest.
 */
export function parseK8sManifests(yaml: string): K8sManifest[] {
  const documents = yaml.split(/\n---\n/);
  const manifests: K8sManifest[] = [];

  for (const doc of documents) {
    const trimmed = doc.trim();
    if (trimmed === "" || trimmed === "---") continue;
    try {
      const parsed = parseYAML(trimmed);
      if (typeof parsed === "object" && parsed !== null) {
        manifests.push(parsed as K8sManifest);
      }
    } catch {
      // Skip unparseable documents
    }
  }

  return manifests;
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

    default:
      return null;
  }
}

/**
 * Extract all containers (including init containers) from a workload manifest.
 */
export function extractContainers(manifest: K8sManifest): K8sContainer[] {
  const podSpec = extractPodSpec(manifest);
  if (!podSpec) return [];

  const containers: K8sContainer[] = [];

  if (Array.isArray(podSpec.containers)) {
    for (const c of podSpec.containers) {
      if (typeof c === "object" && c !== null) {
        containers.push(c as K8sContainer);
      }
    }
  }

  if (Array.isArray(podSpec.initContainers)) {
    for (const c of podSpec.initContainers) {
      if (typeof c === "object" && c !== null) {
        containers.push(c as K8sContainer);
      }
    }
  }

  return containers;
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
