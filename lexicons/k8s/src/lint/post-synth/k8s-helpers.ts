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
