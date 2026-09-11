/**
 * What this lexicon's entity types are worth to a behaviour engine (#2382).
 *
 * Contributed as rows through the plugin's `behaviourKinds` field; the
 * vocabulary, the resolution and the prediction are
 * `packages/core/src/behaviour-kinds.ts`. These rows were a section of one
 * cross-lexicon table in one lexicon until #2382 moved each substrate's
 * rows to the lexicon that owns the types — this file can say what
 * `K8s::Apps::Deployment` means because it is the file that defines it.
 *
 * A table rather than a heuristic over type names: a heuristic would map
 * `K8s::Rbac::RoleBinding` to storage and price a join table.
 */

import type { BehaviourKinds } from "@intentius/chant/behaviour-kinds";

/** Types an engine prices, with the declared property its size is read from. */
const MAPPED: BehaviourKinds["mapped"] = {

  // No `sizeProp` on the five workload kinds. A workload's size is its pod
  // template's container resource requests — an object, per container, over an
  // array — and this contract's `size` is one string in the provider's own
  // vocabulary. Kubernetes has no such string for a workload. Naming
  // `spec.template.spec.containers` here, as the first version did, advertised
  // a column that resolved to an array and therefore to nothing, on every
  // Kubernetes workload in the repository.
  "K8s::Apps::Deployment": { kind: "compute" },
  "K8s::Apps::StatefulSet": { kind: "compute" },
  "K8s::Apps::DaemonSet": { kind: "compute" },
  "K8s::Core::Pod": { kind: "compute" },
  "K8s::Batch::Job": { kind: "serverless" },
  "K8s::Batch::CronJob": { kind: "serverless" },
  // These two do state a size, as a single string in Kubernetes' own
  // vocabulary: a quantity (`20Gi`) and a service type (`LoadBalancer`).
  "K8s::Core::PersistentVolumeClaim": { kind: "block-store", sizeProp: "spec.resources.requests.storage", sizeType: "string" },
  "K8s::Core::Service": { kind: "load-balancer", sizeProp: "spec.type", sizeType: "string" },
  "K8s::Networking::Ingress": { kind: "load-balancer" },
};

/**
 * Types considered and declared unsendable, each with the reason it carries no
 * rate. The fifth family core's contributor guidance names is this lexicon's
 * own: a controller's request is not the thing it creates. A `Certificate`
 * costs nothing; the issuer's work and the Secret it writes are elsewhere in
 * the graph or outside the cluster entirely.
 */
const UNMAPPED: BehaviourKinds["unmapped"] = {
  "K8s::Rbac::Role": "an RBAC role is a grant; the workloads it admits are what cost and saturate",
  "K8s::Rbac::RoleBinding": "an RBAC binding is a grant; the workloads it admits are what cost and saturate",
  "K8s::Rbac::ClusterRole": "the cluster-scoped twin of an RBAC role, and a grant for the same reason",
  "K8s::Rbac::ClusterRoleBinding": "the cluster-scoped twin of an RBAC binding, and a grant for the same reason",
  "K8s::Core::ServiceAccount": "an identity, not a workload",
  "K8s::Core::Namespace": "a boundary the workloads sit inside, and the workloads carry the figures",
  "K8s::Networking::IngressClass": "names which controller handles an Ingress; the controller and the load balancer it creates carry the figures",
  "K8s::Networking::NetworkPolicy": "a filter on edges that already exist, not a thing at either end of one",
  "K8s::Storage::StorageClass": "the kind of disk a claim may ask for; the PersistentVolumeClaim carries the figures",
  "K8s::Autoscaling::HorizontalPodAutoscaler": "an instruction about how many replicas to run; the workload it scales carries the figures, and a prediction is at one stated traffic level rather than across a scaling range",
  "K8s::HorizontalPodAutoscaler": "an instruction about how many replicas to run; the workload it scales carries the figures, and a prediction is at one stated traffic level rather than across a scaling range",
  "K8s::Policy::PodDisruptionBudget": "a constraint on voluntary eviction. It shapes what a lost zone does to a workload and has no rate of its own; expressing that constraint to an engine is a resilience input this contract has no field for",
  "K8s::Core::LimitRange": "a default and a ceiling for workloads in a namespace; the workloads carry the figures",
  "K8s::Core::ResourceQuota": "a ceiling on a namespace's total requests; the workloads under it carry the figures",
  // ── A controller's request is not the thing it creates ───────────
  "K8s::Argo::Application": "a request to Argo CD to reconcile a source; whatever it creates is priced where that lands",
  "K8s::Flux::GitRepository": "a source Flux polls; the workloads it reconciles carry the figures",
  "K8s::Flux::Kustomization": "a request to Flux to apply a source; whatever it creates is priced where that lands",
  "K8s::CertManager::Certificate": "a request to an issuer. The certificate costs nothing; the issuer's work and the Secret it writes are elsewhere",
  "K8s::CertManager::ClusterIssuer": "the issuer a certificate request names; it holds no capacity and serves no traffic",
  "K8s::ExternalSecrets::ExternalSecret": "a request to copy a value from an external store into a Secret; neither end is a rate",
  "K8s::ExternalSecrets::ClusterSecretStore": "names where secrets are fetched from; it holds no capacity and serves no traffic",
  "K8s::Monitoring::ServiceMonitor": "tells Prometheus what to scrape; Prometheus is a workload elsewhere in the graph and carries the figures",
  "K8s::Monitoring::PrometheusRule": "alerting and recording rules evaluated by Prometheus, which carries the figures",
  "K8s::Traefik::IngressRoute": "routing handled by the Traefik workload, which carries the figures",
  "K8s::Calico::FelixConfiguration": "tuning for the CNI agent on every node; the nodes carry the figures",
  "K8s::GKE::BackendConfig": "tuning for a Google load balancer an Ingress creates; the gcp substrate is not modelled here, so neither end is priced here",
  "K8s::NetworkingGKE::ManagedCertificate": "a certificate Google issues for an Ingress; the gcp substrate is not modelled here",
  "K8s::NetworkingGKEBeta::FrontendConfig": "tuning for a Google load balancer an Ingress creates; the gcp substrate is not modelled here",
  // ── Configuration and secrets: real, declared, carrying no rate ──
  "K8s::Core::ConfigMap": "configuration the workloads read; it has no rate and no saturation axis of its own",
  "K8s::Core::Secret": "configuration the workloads read; it has no rate and no saturation axis of its own",
};

/** This lexicon's answer for its own types. */
export const k8sBehaviourKinds: BehaviourKinds = {
  provider: "kubernetes",
  prefixes: ["K8s::"],
  mapped: MAPPED,
  unmapped: UNMAPPED,
};
