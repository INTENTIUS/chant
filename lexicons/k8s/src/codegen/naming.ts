/**
 * Kubernetes naming strategy — maps K8s::{Group}::{Kind} type names
 * to user-friendly TypeScript class names.
 */

import {
  NamingStrategy as CoreNamingStrategy,
  type NamingConfig,
  type NamingInput,
} from "@intentius/chant/codegen/naming";
import { k8sShortName, k8sServiceName, type K8sParseResult } from "../spec/parse";

export { propertyTypeName, extractDefName } from "@intentius/chant/codegen/naming";

const k8sNamingConfig: NamingConfig = {
  priorityNames: {
    // Core
    "K8s::Core::Pod": "Pod",
    "K8s::Core::Service": "Service",
    "K8s::Core::ConfigMap": "ConfigMap",
    "K8s::Core::Secret": "Secret",
    "K8s::Core::Namespace": "Namespace",
    "K8s::Core::ServiceAccount": "ServiceAccount",
    "K8s::Core::PersistentVolume": "PersistentVolume",
    "K8s::Core::PersistentVolumeClaim": "PersistentVolumeClaim",
    "K8s::Core::Node": "Node",
    "K8s::Core::Endpoints": "Endpoints",
    "K8s::Core::ResourceQuota": "ResourceQuota",
    "K8s::Core::LimitRange": "LimitRange",
    "K8s::Core::ReplicationController": "ReplicationController",

    // Apps
    "K8s::Apps::Deployment": "Deployment",
    "K8s::Apps::StatefulSet": "StatefulSet",
    "K8s::Apps::DaemonSet": "DaemonSet",
    "K8s::Apps::ReplicaSet": "ReplicaSet",
    "K8s::Apps::ControllerRevision": "ControllerRevision",

    // Batch
    "K8s::Batch::Job": "Job",
    "K8s::Batch::CronJob": "CronJob",

    // Networking
    "K8s::Networking::Ingress": "Ingress",
    "K8s::Networking::IngressClass": "IngressClass",
    "K8s::Networking::NetworkPolicy": "NetworkPolicy",

    // RBAC
    "K8s::Rbac::Role": "Role",
    "K8s::Rbac::ClusterRole": "ClusterRole",
    "K8s::Rbac::RoleBinding": "RoleBinding",
    "K8s::Rbac::ClusterRoleBinding": "ClusterRoleBinding",

    // Autoscaling
    "K8s::Autoscaling::HorizontalPodAutoscaler": "HorizontalPodAutoscaler",

    // Policy
    "K8s::Policy::PodDisruptionBudget": "PodDisruptionBudget",

    // Storage
    "K8s::Storage::StorageClass": "StorageClass",
    "K8s::Storage::CSIDriver": "CSIDriver",

    // Scheduling
    "K8s::Scheduling::PriorityClass": "PriorityClass",

    // Coordination
    "K8s::Coordination::Lease": "Lease",

    // Discovery
    "K8s::Discovery::EndpointSlice": "EndpointSlice",

    // Certificates
    "K8s::Certificates::CertificateSigningRequest": "CertificateSigningRequest",

    // Admission
    "K8s::Admissionregistration::ValidatingWebhookConfiguration": "ValidatingWebhookConfiguration",
    "K8s::Admissionregistration::MutatingWebhookConfiguration": "MutatingWebhookConfiguration",

    // Events (core vs events.k8s.io — the core version wins)
    "K8s::Core::Event": "Event",

    // Property types
    "K8s::Core::Container": "Container",
    "K8s::Core::ContainerPort": "ContainerPort",
    "K8s::Core::EnvVar": "EnvVar",
    "K8s::Core::EnvFromSource": "EnvFromSource",
    "K8s::Core::Volume": "Volume",
    "K8s::Core::VolumeMount": "VolumeMount",
    "K8s::Core::PodSpec": "PodSpec",
    "K8s::Core::PodTemplateSpec": "PodTemplateSpec",
    "K8s::Core::ServicePort": "ServicePort",
    "K8s::Core::Probe": "Probe",
    "K8s::Core::ResourceRequirements": "ResourceRequirements",
    "K8s::Core::SecurityContext": "SecurityContext",
    "K8s::Core::PodSecurityContext": "PodSecurityContext",
    "K8s::Core::Capabilities": "Capabilities",
    "K8s::Core::ConfigMapKeySelector": "ConfigMapKeySelector",
    "K8s::Core::SecretKeySelector": "SecretKeySelector",
    "K8s::Core::EnvVarSource": "EnvVarSource",
    "K8s::Core::ObjectReference": "ObjectReference",
    "K8s::Core::LocalObjectReference": "LocalObjectReference",
    "K8s::Core::Toleration": "Toleration",
    "K8s::Core::Affinity": "Affinity",
    "K8s::Core::TopologySpreadConstraint": "TopologySpreadConstraint",
    "K8s::Core::PersistentVolumeClaimSpec": "PersistentVolumeClaimSpec",
    "K8s::Core::HTTPGetAction": "HTTPGetAction",
    "K8s::Core::TCPSocketAction": "TCPSocketAction",
    "K8s::Core::ExecAction": "ExecAction",
    "K8s::Core::HostAlias": "HostAlias",
    "K8s::Core::EphemeralContainer": "EphemeralContainer",
    "K8s::Core::KeyToPath": "KeyToPath",
    "K8s::Apps::DeploymentStrategy": "DeploymentStrategy",
    "K8s::Apps::RollingUpdateDeployment": "RollingUpdateDeployment",
    "K8s::Networking::IngressRule": "IngressRule",
    "K8s::Networking::IngressTLS": "IngressTLS",
    "K8s::Networking::HTTPIngressPath": "HTTPIngressPath",
    "K8s::Networking::IngressBackend": "IngressBackend",
    "K8s::Networking::IngressServiceBackend": "IngressServiceBackend",
    "K8s::Networking::ServiceBackendPort": "ServiceBackendPort",
    "K8s::Networking::NetworkPolicyIngressRule": "NetworkPolicyIngressRule",
    "K8s::Networking::NetworkPolicyEgressRule": "NetworkPolicyEgressRule",
    "K8s::Networking::NetworkPolicyPeer": "NetworkPolicyPeer",
    "K8s::Networking::NetworkPolicyPort": "NetworkPolicyPort",
    "K8s::Rbac::PolicyRule": "PolicyRule",
    "K8s::Rbac::RoleRef": "RoleRef",
    "K8s::Rbac::Subject": "Subject",
    "K8s::Autoscaling::MetricSpec": "MetricSpec",
    "K8s::Autoscaling::HorizontalPodAutoscalerBehavior": "HorizontalPodAutoscalerBehavior",
    "K8s::Policy::PodDisruptionBudgetSpec": "PodDisruptionBudgetSpec",
    "K8s::Meta::ObjectMeta": "ObjectMeta",
    "K8s::Meta::LabelSelector": "LabelSelector",
    "K8s::Meta::LabelSelectorRequirement": "LabelSelectorRequirement",
  },

  priorityAliases: {
    "K8s::Batch::Job": ["BatchJob"],
    "K8s::Apps::Deployment": ["Deploy"],
    "K8s::Core::ConfigMap": ["CM"],
    "K8s::Core::ServiceAccount": ["SA"],
    "K8s::Autoscaling::HorizontalPodAutoscaler": ["HPA"],
    "K8s::Core::PersistentVolumeClaim": ["PVC"],
    "K8s::Core::PersistentVolume": ["PV"],
    "K8s::Policy::PodDisruptionBudget": ["PDB"],
    "K8s::Core::Namespace": ["NS"],
    "K8s::Apps::StatefulSet": ["STS"],
    "K8s::Apps::DaemonSet": ["DS"],
    "K8s::Core::Secret": ["Sec"],
    "K8s::Networking::Ingress": ["Ing"],
    "K8s::Networking::NetworkPolicy": ["NetPol"],
  },

  priorityPropertyAliases: {},

  serviceAbbreviations: {
    Core: "Core",
    Apps: "Apps",
    Batch: "Batch",
    Networking: "Net",
    Rbac: "Rbac",
    Autoscaling: "AS",
    Policy: "Pol",
    Storage: "Stor",
    Scheduling: "Sched",
    Coordination: "Coord",
    Discovery: "Disc",
    Certificates: "Cert",
    Admissionregistration: "Adm",
  },

  shortName: k8sShortName,
  serviceName: k8sServiceName,
};

/**
 * Kubernetes-specific naming strategy.
 * Extends core NamingStrategy with K8s naming config.
 */
export class NamingStrategy extends CoreNamingStrategy {
  constructor(results: K8sParseResult[]) {
    const inputs: NamingInput[] = results.map((r) => ({
      typeName: r.resource.typeName,
      propertyTypes: r.propertyTypes,
    }));
    super(inputs, k8sNamingConfig);
  }
}
