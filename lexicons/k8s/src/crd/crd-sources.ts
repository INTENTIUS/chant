/**
 * Third-party CRD sources included in k8s lexicon generation.
 *
 * Add entries here to have CRDs fetched and code-generated alongside
 * the core Kubernetes OpenAPI types. The CRD YAML is fetched at
 * generation time (npm run generate) and baked into the output.
 */

import type { CRDSource } from "./types";

/**
 * KubeRay operator CRDs — ray.io/v1
 *
 * Produces:
 *   K8s::Ray::RayCluster  → apiVersion: ray.io/v1, kind: RayCluster
 *   K8s::Ray::RayJob      → apiVersion: ray.io/v1, kind: RayJob
 *   K8s::Ray::RayService  → apiVersion: ray.io/v1, kind: RayService
 *
 * Operator install: kubectl apply -f
 *   https://github.com/ray-project/kuberay/releases/download/v1.3.0/kuberay-operator.yaml
 */
const KUBERAY_VERSION = "v1.3.0";
const KUBERAY_CRD_BASE = `https://raw.githubusercontent.com/ray-project/kuberay/${KUBERAY_VERSION}/helm-chart/kuberay-operator/crds`;

export const CRD_SOURCES: CRDSource[] = [
  { type: "url", url: `${KUBERAY_CRD_BASE}/ray.io_rayclusters.yaml` },
  { type: "url", url: `${KUBERAY_CRD_BASE}/ray.io_rayjobs.yaml` },
  { type: "url", url: `${KUBERAY_CRD_BASE}/ray.io_rayservices.yaml` },
];
