/**
 * The kinds chant sweeps when nothing narrows the question.
 *
 * A *product* decision — what a bare `chant import` should pull back, and
 * (chant #1075) which kinds an ownership-scoped prune has to look at to notice
 * that a whole kind was removed from source. Not an addressing limit: since
 * chant #1074 removed `KUBECTL_RESOURCE`, a `--selector type=<entity type>`
 * import can name any of the ~180 types the generated operation surface
 * carries, CRDs included.
 *
 * It lives in its own module, with no imports of its own, because both
 * consumers reach it from different directions — `../export-resources.ts`
 * pulls in the whole import parser, and a Temporal worker loading the apply
 * activity should not.
 */
export const DEFAULT_IMPORT_TYPES: readonly string[] = [
  "K8s::Apps::Deployment",
  "K8s::Apps::StatefulSet",
  "K8s::Apps::DaemonSet",
  "K8s::Apps::ReplicaSet",
  "K8s::Core::Service",
  "K8s::Core::ConfigMap",
  "K8s::Core::Secret",
  "K8s::Core::Namespace",
  "K8s::Core::Pod",
  "K8s::Core::PersistentVolumeClaim",
  "K8s::Core::ServiceAccount",
  "K8s::Batch::Job",
  "K8s::Batch::CronJob",
  "K8s::Networking::Ingress",
  "K8s::Networking::NetworkPolicy",
  "K8s::Rbac::Role",
  "K8s::Rbac::RoleBinding",
  "K8s::Rbac::ClusterRole",
  "K8s::Rbac::ClusterRoleBinding",
];
