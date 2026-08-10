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
 * CloudNativePG CRDs — postgresql.cnpg.io/v1
 *
 * The Postgres operator. Produces, under the `Cnpg` namespace (both groups are
 * mapped there explicitly in parser.ts; the first-segment rule would otherwise
 * split them into `Postgresql` and `Barmancloud`):
 *   K8s::Cnpg::Cluster          → postgresql.cnpg.io/v1
 *   K8s::Cnpg::ScheduledBackup  → postgresql.cnpg.io/v1
 *   K8s::Cnpg::Backup           → postgresql.cnpg.io/v1
 *   K8s::Cnpg::Pooler           → postgresql.cnpg.io/v1
 *
 * Pinned to 1.29.1 rather than latest (1.30.0) because that is the operator a
 * real consumer runs — BinaryBourbon/fountain's k8s overlay.
 *
 * Note on ScheduledBackup.schedule: it is a **six**-field cron with leading
 * seconds, not the five-field form Kubernetes CronJob takes. The schema types
 * it as a plain string, so a five-field value passes every check here and
 * silently means something else on the cluster.
 *
 * Database, Publication and Subscription are deliberately left out — no known
 * consumer needs them, and pulling a whole provider is what the note at the top
 * of this file warns against.
 *
 * Operator install: kubectl apply --server-side -f
 *   https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.29/releases/cnpg-1.29.1.yaml
 */
const CNPG_VERSION = "v1.29.1";
const CNPG_CRD_BASE = `https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/${CNPG_VERSION}/config/crd/bases`;

/**
 * barman-cloud plugin CRD — barmancloud.cnpg.io/v1
 *
 * CNPG's WAL archiving / object-storage backend, shipped as a separate plugin
 * with its own release train. Produces:
 *   K8s::Cnpg::ObjectStore  → barmancloud.cnpg.io/v1
 *
 * A CNPG Cluster reaches it through `spec.plugins[]` — `name:
 * barman-cloud.cloudnative-pg.io`, `isWALArchiver: true`,
 * `parameters.barmanObjectName` naming the ObjectStore — so the two are only
 * ever useful together.
 *
 * Pinned to 0.14.0 (latest). Its ObjectStore schema is a superset of 0.7.0's:
 * same four spec properties, more detail inside them.
 *
 * Plugin install: kubectl apply -f
 *   https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/v0.14.0/manifest.yaml
 */
const BARMAN_PLUGIN_VERSION = "v0.14.0";
const BARMAN_PLUGIN_CRD_BASE = `https://raw.githubusercontent.com/cloudnative-pg/plugin-barman-cloud/${BARMAN_PLUGIN_VERSION}/config/crd/bases`;
/**
 * Traefik proxy CRDs — traefik.io/v1alpha1
 *
 * Traefik's own routing surface. An `IngressRoute` is not a
 * `networking.k8s.io` Ingress with annotations — it is a distinct CRD with its
 * own matcher grammar, so an estate fronted by Traefik has no expressible edge
 * without these. Produces, under the `Traefik` namespace (first-segment rule,
 * no override needed):
 *   K8s::Traefik::IngressRoute          K8s::Traefik::Middleware
 *   K8s::Traefik::IngressRouteTCP       K8s::Traefik::MiddlewareTCP
 *   K8s::Traefik::IngressRouteUDP       K8s::Traefik::ServersTransport
 *   K8s::Traefik::TLSOption             K8s::Traefik::ServersTransportTCP
 *   K8s::Traefik::TLSStore              K8s::Traefik::TraefikService
 *
 * Only the `traefik.io` group. The chart's crds/ directory also ships
 * `hub.traefik.io_*` (Traefik Hub, a different commercial product, ~12 kinds,
 * no known consumer) and a vendored copy of the Gateway API, which is already
 * generated here from its upstream repo and would collide.
 *
 * Version footgun: the pin below is the **chart** version, and the chart
 * version is not the Traefik version. Chart v41.1.0 ships Traefik v3.7.9.
 * When bumping, record both.
 *
 * Controller install: helm repo add traefik https://traefik.github.io/charts
 *   && helm install traefik traefik/traefik --version 41.1.0
 */
const TRAEFIK_CHART_VERSION = "v41.1.0";
const TRAEFIK_CRD_BASE = `https://raw.githubusercontent.com/traefik/traefik-helm-chart/${TRAEFIK_CHART_VERSION}/traefik/crds`;
/**
 * Infisical operator CRDs — secrets.infisical.com/v1alpha1
 *
 * The declarative form of chant's own secrets boundary. An `InfisicalSecret`
 * says where a secret comes from and who may fetch it; it never carries a
 * value. Without it an estate can declare the Deployment that consumes a
 * Secret but not the thing that makes the Secret exist. Produces, under the
 * `Infisical` namespace:
 *   K8s::Infisical::InfisicalSecret
 *   K8s::Infisical::InfisicalPushSecret
 *   K8s::Infisical::InfisicalDynamicSecret
 *
 * The group is overridden to `Infisical` in parser.ts. The first-segment rule
 * would give `K8s::Secrets::InfisicalSecret`, which reads like a core Secret
 * next to the `K8s::Core::Secret` that already exists.
 *
 * Two things about the URL, both easy to lose an hour to:
 *   - The operator lives in its own repo, `Infisical/kubernetes-operator`.
 *     The path under the `Infisical/infisical` monorepo 404s.
 *   - The tag is path-shaped — `infisical-k8-operator/v0.11.7`. Not a typo,
 *     and not a directory.
 *
 * Operator install: helm repo add infisical https://dl.cloudsmith.io/public/infisical/helm-charts/helm/charts/
 *   && helm install infisical-secrets-operator infisical/secrets-operator
 */
const INFISICAL_OPERATOR_VERSION = "infisical-k8-operator/v0.11.7";
const INFISICAL_CRD_BASE = `https://raw.githubusercontent.com/Infisical/kubernetes-operator/${INFISICAL_OPERATOR_VERSION}/config/crd/bases`;

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

/**
 * Flux GitOps Toolkit CRDs — the five `*.toolkit.fluxcd.io` groups.
 *
 * The flux2 release `install.yaml` is a single multi-doc bundle (controllers,
 * RBAC, and CRDs); the parser keeps only the CustomResourceDefinition docs, and
 * the `kinds` allowlist below narrows those to the supported set — the bundle
 * also carries `ExternalArtifact` and `ArtifactGenerator` (experimental, and a
 * separate `source.extensions.fluxcd.io` group), which are intentionally left
 * out. All groups map to the `Flux` namespace (see GROUP_NAMESPACE_OVERRIDES in
 * crd/parser.ts):
 *   K8s::Flux::GitRepository / OCIRepository / HelmRepository / HelmChart / Bucket
 *                                          → source.toolkit.fluxcd.io/v1
 *   K8s::Flux::Kustomization               → kustomize.toolkit.fluxcd.io/v1
 *   K8s::Flux::HelmRelease                 → helm.toolkit.fluxcd.io/v2
 *   K8s::Flux::Provider / Alert            → notification.toolkit.fluxcd.io/v1beta3
 *   K8s::Flux::Receiver                    → notification.toolkit.fluxcd.io/v1
 *   K8s::Flux::ImagePolicy / ImageRepository / ImageUpdateAutomation
 *                                          → image.toolkit.fluxcd.io/v1
 *
 * Controller install: kubectl apply -f
 *   https://github.com/fluxcd/flux2/releases/download/v2.9.1/install.yaml
 */
const FLUX_TOOLKIT_VERSION = "v2.9.1";
const FLUX_TOOLKIT_INSTALL = `https://github.com/fluxcd/flux2/releases/download/${FLUX_TOOLKIT_VERSION}/install.yaml`;

/**
 * Flux Operator CRDs — fluxcd.controlplane.io/v1
 *
 * The operator that installs and manages a Flux instance declaratively. Its
 * release `install.yaml` bundles the four CRDs alongside the operator
 * Deployment/RBAC; the parser keeps only the CRDs. They map to the `Flux`
 * namespace (GROUP_NAMESPACE_OVERRIDES):
 *   K8s::Flux::FluxInstance              → fluxcd.controlplane.io/v1
 *   K8s::Flux::FluxReport                → fluxcd.controlplane.io/v1
 *   K8s::Flux::ResourceSet               → fluxcd.controlplane.io/v1
 *   K8s::Flux::ResourceSetInputProvider  → fluxcd.controlplane.io/v1
 *
 * Operator install: kubectl apply -f
 *   https://github.com/controlplaneio-fluxcd/flux-operator/releases/download/v0.54.1/install.yaml
 */
const FLUX_OPERATOR_VERSION = "v0.54.1";
const FLUX_OPERATOR_INSTALL = `https://github.com/controlplaneio-fluxcd/flux-operator/releases/download/${FLUX_OPERATOR_VERSION}/install.yaml`;

/**
 * KubeMicroVM CRDs — lambda.aws.amazon.com/v1alpha1
 *
 * Produces (the group is mapped to the `KubeMicroVM` namespace — see
 * GROUP_NAMESPACE_OVERRIDES in crd/parser.ts):
 *   K8s::KubeMicroVM::MicroVM            → kind: MicroVM
 *   K8s::KubeMicroVM::MicroVMImage       → kind: MicroVMImage
 *   K8s::KubeMicroVM::MicroVMNetwork     → kind: MicroVMNetwork
 *   K8s::KubeMicroVM::MicroVMClass       → kind: MicroVMClass
 *   K8s::KubeMicroVM::MicroVMReplicaSet  → kind: MicroVMReplicaSet
 *
 * Sourced from the chart rather than a raw URL: the operator is built with
 * the Java operator SDK, which generates CRDs at build time, and only
 * `microvmclasses` is committed to their repo. All five are in the published
 * chart.
 *
 * Operator install: helm install kube-microvm-operator
 *   oci://ghcr.io/codriverlabs/helm/kube-microvm-operator --version 1.0.11
 */
const KUBEMICROVM_CHART = "oci://ghcr.io/codriverlabs/helm/kube-microvm-operator";
const KUBEMICROVM_VERSION = "1.0.11";

/**
 * k3s bundled-controller CRDs — helm.cattle.io/v1 + k3s.cattle.io/v1
 *
 * k3s's manifest auto-deploy machinery speaks these CRDs: drop a HelmChart
 * into /var/lib/rancher/k3s/server/manifests and the embedded helm-controller
 * installs the chart; every auto-deployed manifest is tracked by an Addon.
 * Typed here for the same reason the Flux toolkit kinds are — they are what a
 * k3s estate's GitOps surface is written in.
 *
 * Produces (both groups map to the `K3s` namespace — see
 * GROUP_NAMESPACE_OVERRIDES in crd/parser.ts):
 *   K8s::K3s::HelmChart        → apiVersion: helm.cattle.io/v1, kind: HelmChart
 *   K8s::K3s::HelmChartConfig  → apiVersion: helm.cattle.io/v1, kind: HelmChartConfig
 *   K8s::K3s::Addon            → apiVersion: k3s.cattle.io/v1,  kind: Addon
 *
 * The pin is k3s v1.36.3+k3s1 (the release the k3s lexicon pins), but the k3s
 * repo itself publishes no CRD YAMLs — its manifests/ directory carries only
 * the bundled charts, and the API types live in dependency repos. The URLs
 * below point at the exact versions that release vendors in its go.mod:
 *   github.com/k3s-io/helm-controller v0.17.7  (helm.cattle.io CRDs)
 *   github.com/k3s-io/api             v0.1.4   (k3s.cattle.io CRDs)
 * When bumping, re-read go.mod at the new k3s tag and move both pins together.
 *
 * k3s-io/api also ships an ETCDSnapshotFile CRD — deliberately left out. It is
 * status-only controller bookkeeping (the server writes them to describe
 * snapshots it took); nothing an author would declare.
 *
 * Controller install: none — both controllers are embedded in the k3s binary.
 */
const K3S_HELM_CONTROLLER_VERSION = "v0.17.7"; // vendored by k3s v1.36.3+k3s1
const K3S_API_VERSION = "v0.1.4"; // vendored by k3s v1.36.3+k3s1
const K3S_HELM_CONTROLLER_CRD_BASE = `https://raw.githubusercontent.com/k3s-io/helm-controller/${K3S_HELM_CONTROLLER_VERSION}/pkg/crds/yaml/generated`;
const K3S_API_CRD_BASE = `https://raw.githubusercontent.com/k3s-io/api/${K3S_API_VERSION}/pkg/crds/yaml/generated`;

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
  { type: "url", url: `${CNPG_CRD_BASE}/postgresql.cnpg.io_clusters.yaml` },
  { type: "url", url: `${CNPG_CRD_BASE}/postgresql.cnpg.io_scheduledbackups.yaml` },
  { type: "url", url: `${CNPG_CRD_BASE}/postgresql.cnpg.io_backups.yaml` },
  { type: "url", url: `${CNPG_CRD_BASE}/postgresql.cnpg.io_poolers.yaml` },
  { type: "url", url: `${BARMAN_PLUGIN_CRD_BASE}/barmancloud.cnpg.io_objectstores.yaml` },
  { type: "url", url: `${TRAEFIK_CRD_BASE}/traefik.io_ingressroutes.yaml` },
  { type: "url", url: `${TRAEFIK_CRD_BASE}/traefik.io_ingressroutetcps.yaml` },
  { type: "url", url: `${TRAEFIK_CRD_BASE}/traefik.io_ingressrouteudps.yaml` },
  { type: "url", url: `${TRAEFIK_CRD_BASE}/traefik.io_middlewares.yaml` },
  { type: "url", url: `${TRAEFIK_CRD_BASE}/traefik.io_middlewaretcps.yaml` },
  { type: "url", url: `${TRAEFIK_CRD_BASE}/traefik.io_serverstransports.yaml` },
  { type: "url", url: `${TRAEFIK_CRD_BASE}/traefik.io_serverstransporttcps.yaml` },
  { type: "url", url: `${TRAEFIK_CRD_BASE}/traefik.io_tlsoptions.yaml` },
  { type: "url", url: `${TRAEFIK_CRD_BASE}/traefik.io_tlsstores.yaml` },
  { type: "url", url: `${TRAEFIK_CRD_BASE}/traefik.io_traefikservices.yaml` },
  { type: "url", url: `${INFISICAL_CRD_BASE}/secrets.infisical.com_infisicalsecrets.yaml` },
  { type: "url", url: `${INFISICAL_CRD_BASE}/secrets.infisical.com_infisicalpushsecrets.yaml` },
  { type: "url", url: `${INFISICAL_CRD_BASE}/secrets.infisical.com_infisicaldynamicsecrets.yaml` },
  {
    type: "url",
    url: FLUX_TOOLKIT_INSTALL,
    kinds: [
      "GitRepository",
      "OCIRepository",
      "HelmRepository",
      "HelmChart",
      "Bucket",
      "Kustomization",
      "HelmRelease",
      "Provider",
      "Alert",
      "Receiver",
      "ImagePolicy",
      "ImageRepository",
      "ImageUpdateAutomation",
    ],
  },
  {
    type: "url",
    url: FLUX_OPERATOR_INSTALL,
    kinds: ["FluxInstance", "FluxReport", "ResourceSet", "ResourceSetInputProvider"],
  },
  { type: "url", url: `${K3S_HELM_CONTROLLER_CRD_BASE}/helm.cattle.io_helmcharts.yaml` },
  { type: "url", url: `${K3S_HELM_CONTROLLER_CRD_BASE}/helm.cattle.io_helmchartconfigs.yaml` },
  { type: "url", url: `${K3S_API_CRD_BASE}/k3s.cattle.io_addons.yaml` },
  {
    type: "helm",
    chart: KUBEMICROVM_CHART,
    version: KUBEMICROVM_VERSION,
    kinds: ["MicroVM", "MicroVMImage", "MicroVMNetwork", "MicroVMClass", "MicroVMReplicaSet"],
  },
];
