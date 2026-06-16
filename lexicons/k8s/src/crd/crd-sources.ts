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

/**
 * Gateway API CRDs — gateway.networking.k8s.io (standard channel)
 *
 * The modern, portable replacement for Ingress. GRPCRoute in particular is the
 * native way to express a gRPC route (vs. ingress-controller annotations).
 *
 * Produces (the `gateway.networking.k8s.io` group maps to the `Gateway`
 * namespace via the first-segment rule in crd/parser.ts):
 *   K8s::Gateway::GatewayClass    → apiVersion: gateway.networking.k8s.io/v1,      kind: GatewayClass
 *   K8s::Gateway::Gateway         → apiVersion: gateway.networking.k8s.io/v1,      kind: Gateway
 *   K8s::Gateway::HTTPRoute       → apiVersion: gateway.networking.k8s.io/v1,      kind: HTTPRoute
 *   K8s::Gateway::GRPCRoute       → apiVersion: gateway.networking.k8s.io/v1,      kind: GRPCRoute
 *   K8s::Gateway::ReferenceGrant  → apiVersion: gateway.networking.k8s.io/v1beta1, kind: ReferenceGrant
 *
 * CRD install: kubectl apply -f
 *   https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.1/standard-install.yaml
 */
const GATEWAY_API_VERSION = "v1.2.1";
const GATEWAY_API_CRD_BASE = `https://raw.githubusercontent.com/kubernetes-sigs/gateway-api/${GATEWAY_API_VERSION}/config/crd/standard`;

/**
 * CockroachDB Kubernetes Operator CRD — crdb.cockroachlabs.com/v1alpha1
 *
 * The operator-managed path for a CockroachDB cluster (the operator handles
 * version upgrades, scale-down decommissioning, and cert rotation). Complements
 * the self-managed `CockroachDbCluster` StatefulSet composite.
 *
 * Produces (the `crdb.cockroachlabs.com` group maps to the `Crdb` namespace via
 * the first-segment rule in crd/parser.ts):
 *   K8s::Crdb::CrdbCluster  → apiVersion: crdb.cockroachlabs.com/v1alpha1, kind: CrdbCluster
 *
 * Operator install: kubectl apply -f
 *   https://github.com/cockroachdb/cockroach-operator/releases/download/v2.17.0/install/operator.yaml
 */
const COCKROACH_OPERATOR_VERSION = "v2.17.0";
const COCKROACH_OPERATOR_CRD_BASE = `https://raw.githubusercontent.com/cockroachdb/cockroach-operator/${COCKROACH_OPERATOR_VERSION}/config/crd/bases`;

/**
 * cert-manager CRDs — cert-manager.io + acme.cert-manager.io
 *
 * The de-facto TLS cert issuance/rotation controller. A single multi-doc bundle
 * (the parser uses loadAll) produces, under the `CertManager` and `Acme`
 * namespaces (first-segment rule; "cert-manager.io" → "CertManager"):
 *   K8s::CertManager::Certificate         → cert-manager.io/v1
 *   K8s::CertManager::CertificateRequest  → cert-manager.io/v1
 *   K8s::CertManager::Issuer              → cert-manager.io/v1
 *   K8s::CertManager::ClusterIssuer       → cert-manager.io/v1
 *   K8s::Acme::Challenge                  → acme.cert-manager.io/v1
 *   K8s::Acme::Order                      → acme.cert-manager.io/v1
 *
 * Controller install: kubectl apply -f
 *   https://github.com/cert-manager/cert-manager/releases/download/v1.16.2/cert-manager.yaml
 */
const CERT_MANAGER_VERSION = "v1.16.2";
const CERT_MANAGER_CRD_BUNDLE = `https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager.crds.yaml`;

/**
 * Prometheus Operator CRDs — monitoring.coreos.com/v1
 *
 * Produces (the `monitoring.coreos.com` group maps to the `Monitoring`
 * namespace):
 *   K8s::Monitoring::ServiceMonitor  → apiVersion: monitoring.coreos.com/v1, kind: ServiceMonitor
 *   K8s::Monitoring::PrometheusRule  → apiVersion: monitoring.coreos.com/v1, kind: PrometheusRule
 *
 * Operator install: kube-prometheus-stack chart, or
 *   https://github.com/prometheus-operator/prometheus-operator
 */
const PROM_OPERATOR_VERSION = "v0.79.2";
const PROM_OPERATOR_CRD_BASE = `https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/${PROM_OPERATOR_VERSION}/example/prometheus-operator-crd`;

export const CRD_SOURCES: CRDSource[] = [
  { type: "url", url: `${KUBERAY_CRD_BASE}/ray.io_rayclusters.yaml` },
  { type: "url", url: `${KUBERAY_CRD_BASE}/ray.io_rayjobs.yaml` },
  { type: "url", url: `${KUBERAY_CRD_BASE}/ray.io_rayservices.yaml` },
  { type: "url", url: `${ARGOCD_CRD_BASE}/application-crd.yaml` },
  { type: "url", url: `${ARGOCD_CRD_BASE}/applicationset-crd.yaml` },
  { type: "url", url: `${ARGOCD_CRD_BASE}/appproject-crd.yaml` },
  { type: "url", url: `${GATEWAY_API_CRD_BASE}/gateway.networking.k8s.io_gatewayclasses.yaml` },
  { type: "url", url: `${GATEWAY_API_CRD_BASE}/gateway.networking.k8s.io_gateways.yaml` },
  { type: "url", url: `${GATEWAY_API_CRD_BASE}/gateway.networking.k8s.io_httproutes.yaml` },
  { type: "url", url: `${GATEWAY_API_CRD_BASE}/gateway.networking.k8s.io_grpcroutes.yaml` },
  { type: "url", url: `${GATEWAY_API_CRD_BASE}/gateway.networking.k8s.io_referencegrants.yaml` },
  { type: "url", url: `${COCKROACH_OPERATOR_CRD_BASE}/crdb.cockroachlabs.com_crdbclusters.yaml` },
  { type: "url", url: CERT_MANAGER_CRD_BUNDLE },
  { type: "url", url: `${PROM_OPERATOR_CRD_BASE}/monitoring.coreos.com_servicemonitors.yaml` },
  { type: "url", url: `${PROM_OPERATOR_CRD_BASE}/monitoring.coreos.com_prometheusrules.yaml` },
];
