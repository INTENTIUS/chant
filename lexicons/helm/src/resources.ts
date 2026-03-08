/**
 * Helm-specific resource and property types.
 *
 * Created via createResource/createProperty from @intentius/chant/runtime.
 * These are static types (no upstream schema to fetch).
 */

import { createResource, createProperty } from "@intentius/chant/runtime";

const LEXICON = "helm";

// ── Resources ─────────────────────────────────────────────

/**
 * Helm::Chart — Chart.yaml metadata.
 *
 * Defines the chart's identity: apiVersion, name, version, appVersion,
 * description, type (application|library), keywords, maintainers, dependencies.
 */
export const Chart = createResource("Helm::Chart", LEXICON, {});

/**
 * Helm::Values — Typed values definition.
 *
 * The props passed to the constructor become the default values emitted
 * in values.yaml. The serializer also generates values.schema.json from
 * the value types.
 */
export const Values = createResource("Helm::Values", LEXICON, {});

/**
 * Helm::Test — Helm test pod.
 *
 * Annotated with `helm.sh/hook: test` in the serialized output.
 * Props should contain a K8s Pod spec.
 */
export const HelmTest = createResource("Helm::Test", LEXICON, {});

/**
 * Helm::Notes — NOTES.txt template content.
 *
 * The `content` prop is emitted as templates/NOTES.txt.
 */
export const HelmNotes = createResource("Helm::Notes", LEXICON, {});

// ── Property types ────────────────────────────────────────

/**
 * Helm::Hook — Lifecycle hook annotation.
 *
 * Wraps a K8s resource with helm.sh/hook annotations.
 * Props: { hook: string, weight?: number, deletePolicy?: string, resource: Declarable }
 */
export const HelmHook = createProperty("Helm::Hook", LEXICON);

/**
 * Helm::Dependency — Chart dependency entry.
 *
 * Props: { name, version, repository, condition?, tags?, enabled?, importValues?, alias? }
 */
export const HelmDependency = createProperty("Helm::Dependency", LEXICON);

/**
 * Helm::Maintainer — Chart maintainer entry.
 *
 * Props: { name, email?, url? }
 */
export const HelmMaintainer = createProperty("Helm::Maintainer", LEXICON);

// ── CRD ──────────────────────────────────────────────────

/**
 * Helm::CRD — Custom Resource Definition placed in the crds/ directory.
 *
 * Props: { content: string, filename?: string }
 */
export const HelmCRD = createResource("Helm::CRD", LEXICON, {});

// ── K8s resource types used by composites ────────────────
// These are thin wrappers so composite members are Declarable.

const K8S = "k8s";

export const Deployment = createResource("K8s::Apps::Deployment", K8S, {});
export const StatefulSet = createResource("K8s::Apps::StatefulSet", K8S, {});
export const DaemonSet = createResource("K8s::Apps::DaemonSet", K8S, {});
export const Service = createResource("K8s::Core::Service", K8S, {});
export const ServiceAccount = createResource("K8s::Core::ServiceAccount", K8S, {});
export const ConfigMap = createResource("K8s::Core::ConfigMap", K8S, {});
export const Namespace = createResource("K8s::Core::Namespace", K8S, {});
export const Job = createResource("K8s::Batch::Job", K8S, {});
export const CronJob = createResource("K8s::Batch::CronJob", K8S, {});
export const Ingress = createResource("K8s::Networking::Ingress", K8S, {});
export const NetworkPolicy = createResource("K8s::Networking::NetworkPolicy", K8S, {});
export const HPA = createResource("K8s::Autoscaling::HorizontalPodAutoscaler", K8S, {});
export const PDB = createResource("K8s::Policy::PodDisruptionBudget", K8S, {});
export const ResourceQuota = createResource("K8s::Core::ResourceQuota", K8S, {});
export const LimitRange = createResource("K8s::Core::LimitRange", K8S, {});
export const ClusterRole = createResource("K8s::Rbac::ClusterRole", K8S, {});
export const ClusterRoleBinding = createResource("K8s::Rbac::ClusterRoleBinding", K8S, {});
export const Role = createResource("K8s::Rbac::Role", K8S, {});
export const RoleBinding = createResource("K8s::Rbac::RoleBinding", K8S, {});
export const ExternalSecret = createResource("K8s::ExternalSecrets::ExternalSecret", K8S, {});
export const ServiceMonitor = createResource("K8s::Monitoring::ServiceMonitor", K8S, {});
export const PrometheusRule = createResource("K8s::Monitoring::PrometheusRule", K8S, {});
export const Certificate = createResource("K8s::CertManager::Certificate", K8S, {});
