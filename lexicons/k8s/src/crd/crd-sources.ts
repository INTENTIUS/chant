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

/**
 * Argo CD CRDs — argoproj.io/v1alpha1
 *
 * Produces (the `argoproj.io` group is mapped to the `Argo` namespace —
 * see GROUP_NAMESPACE_OVERRIDES in crd/parser.ts):
 *   K8s::Argo::Application     → apiVersion: argoproj.io/v1alpha1, kind: Application
 *   K8s::Argo::ApplicationSet  → apiVersion: argoproj.io/v1alpha1, kind: ApplicationSet
 *   K8s::Argo::AppProject      → apiVersion: argoproj.io/v1alpha1, kind: AppProject
 *
 * Operator install: kubectl apply -n argocd -f
 *   https://raw.githubusercontent.com/argoproj/argo-cd/v2.13.3/manifests/install.yaml
 */
const ARGOCD_VERSION = "v2.13.3";
const ARGOCD_CRD_BASE = `https://raw.githubusercontent.com/argoproj/argo-cd/${ARGOCD_VERSION}/manifests/crds`;

export const CRD_SOURCES: CRDSource[] = [
  { type: "url", url: `${KUBERAY_CRD_BASE}/ray.io_rayclusters.yaml` },
  { type: "url", url: `${KUBERAY_CRD_BASE}/ray.io_rayjobs.yaml` },
  { type: "url", url: `${KUBERAY_CRD_BASE}/ray.io_rayservices.yaml` },
  { type: "url", url: `${ARGOCD_CRD_BASE}/application-crd.yaml` },
  { type: "url", url: `${ARGOCD_CRD_BASE}/applicationset-crd.yaml` },
  { type: "url", url: `${ARGOCD_CRD_BASE}/appproject-crd.yaml` },
];
