import type { IdentityRule, ReferenceCatalog, RefRule, ScopeRule } from "@intentius/chant/graph-refs";

/**
 * Kubernetes reference catalog (#4535): how Kubernetes objects name each
 * other, so chant's catalog pass (`reconstructIndexedEdges`, #4522) draws
 * their edges over an index and over a declared graph, and behold can retire
 * its name matcher (behold#1005).
 *
 * ## Shape and scope
 *
 * The paths are the manifest's own (`metadata`, `spec`), which is the tree a
 * listed object becomes once `apiVersion` and `kind` are dropped
 * (./listed-types.ts `k8sObservedTree`) and the shape the lexicon's declared
 * props have. Every target is identified by `metadata.name`.
 *
 * A name is unique only inside its namespace. Over an index a namespaced
 * object's location is its namespace (behold#1025), so the scoped join key
 * (behold#1023's ruling) keeps a `serviceAccountName: default` inside its own
 * namespace, and a namespaced holder also reaches cluster-scoped objects (a
 * `Namespace`, a `ClusterRole`, a `StorageClass`). On a declared graph,
 * `chant workspace graph`'s catalog pass (#5097) reads the namespace from
 * `metadata.namespace` through `scopes`, so a name joins across members
 * inside one namespace, and a namespaced object that names none stays inside
 * its own member. Two objects that match one name in one namespace make the
 * reference ambiguous, and it draws no edge.
 *
 * ## Multi-kind fields
 *
 * A field that can name one of several kinds (`scaleTargetRef`, `roleRef`,
 * a binding's `subjects`, an owner reference) has one rule per kind, each
 * `optional`, so a value that names a node of another kind is not dangling
 * under the rules it does not match.
 *
 * ## Values that may name a cloud resource
 *
 * A container's env var value can be the literal name of a bucket it uses
 * (behold#166's case: `ASSET_BUCKET` set to the bucket's `BucketName`). The
 * env-value rules join such a value to an `AWS::S3::Bucket` of that name, and
 * are `optional`, since most env values name nothing. Over an index the
 * cluster and the AWS account are two scopes, so the join only draws on a
 * declared graph, where a cloud resource sits in the scope every namespace
 * reaches, which is where behold's matcher drew it.
 *
 * ## What this does not do
 *
 * - Label selectors. A Service selects pods by a set of labels, and a rule
 *   matches one value at one path, so a selector on the standard keys
 *   (`app.kubernetes.io/name`) is not read. Only the bare `app` label is
 *   matched: a Service's `spec.selector.app` to a workload whose pod
 *   template carries the same `app` label. behold's own k8s pass (src/k8s-edges.ts) still joins full
 *   selectors on behold's side.
 *
 * Annotation keys are reachable since #5097, as a quoted step:
 * `metadata.annotations["eks.amazonaws.com/role-arn"]`. Rules that read them
 * come with the issues that need them.
 *
 * ## Adding a rule
 *
 * A rule is one entry in `refs`: the holder kind, the path, the target kind
 * and a label, through `ref` (or `anyOf` for a field that can name several
 * kinds). Its id is `k8s:<holder kind>:<path>`, which every edge, dangling
 * entry and ambiguous entry it makes carries as `rule`. A target kind that
 * other objects name by `metadata.name` goes in `NAMED_KINDS`, and a
 * namespaced one in `NAMESPACED_KINDS` too. The test "each rule draws its
 * edge" covers a new rule with no test of its own.
 */

/** Workload kinds and the path to their pod spec. */
const POD_SPECS: ReadonlyArray<readonly [kind: string, podSpec: string]> = [
  ["K8s::Core::Pod", "spec"],
  ["K8s::Apps::Deployment", "spec.template.spec"],
  ["K8s::Apps::StatefulSet", "spec.template.spec"],
  ["K8s::Apps::DaemonSet", "spec.template.spec"],
  ["K8s::Apps::ReplicaSet", "spec.template.spec"],
  ["K8s::Batch::Job", "spec.template.spec"],
  ["K8s::Batch::CronJob", "spec.jobTemplate.spec.template.spec"],
];

/** Kinds that sit in a namespace, so `metadata.namespace` places them. */
const NAMESPACED_KINDS = [
  ...POD_SPECS.map(([kind]) => kind),
  "K8s::Core::Service",
  "K8s::Core::ConfigMap",
  "K8s::Core::Secret",
  "K8s::Core::ServiceAccount",
  "K8s::Core::PersistentVolumeClaim",
  "K8s::Networking::Ingress",
  "K8s::Networking::NetworkPolicy",
  "K8s::Autoscaling::HorizontalPodAutoscaler",
  "K8s::Policy::PodDisruptionBudget",
  "K8s::Rbac::Role",
  "K8s::Rbac::RoleBinding",
];

/** Kinds other objects name by `metadata.name`. */
const NAMED_KINDS = [
  ...NAMESPACED_KINDS,
  "K8s::Core::Namespace",
  "K8s::Core::PersistentVolume",
  "K8s::Networking::IngressClass",
  "K8s::Storage::StorageClass",
  "K8s::Rbac::ClusterRole",
];

/** Workloads whose pod template a Service's `app` selector can match. */
const SELECTED_WORKLOADS = ["K8s::Apps::Deployment", "K8s::Apps::StatefulSet", "K8s::Apps::DaemonSet"];

const identities: IdentityRule[] = NAMED_KINDS.map((kind) => ({
  kind,
  ids: SELECTED_WORKLOADS.includes(kind) ? ["metadata.name", "spec.template.metadata.labels.app"] : ["metadata.name"],
}));

type Rel = RefRule["relation"];

const ref = (from: string, path: string, targetKind: string, label: string, relation: Rel = "reference"): RefRule => ({ from, path, targetKind, relation, label });

const anyOf = (from: string, path: string, targetKinds: readonly string[], label: string): RefRule[] =>
  targetKinds.map((targetKind) => ({ from, path, targetKind, relation: "reference" as const, label, optional: true }));

/** What a pod spec names: its service account, mounted config and secrets, claims, pull secrets. */
function podSpecRules(kind: string, p: string): RefRule[] {
  const containers = [`${p}.containers[]`, `${p}.initContainers[]`];
  return [
    ref(kind, `${p}.serviceAccountName`, "K8s::Core::ServiceAccount", "runs as"),
    ref(kind, `${p}.volumes[].configMap.name`, "K8s::Core::ConfigMap", "mounts"),
    ref(kind, `${p}.volumes[].secret.secretName`, "K8s::Core::Secret", "mounts"),
    ref(kind, `${p}.volumes[].persistentVolumeClaim.claimName`, "K8s::Core::PersistentVolumeClaim", "mounts"),
    ref(kind, `${p}.volumes[].projected.sources[].configMap.name`, "K8s::Core::ConfigMap", "mounts"),
    ref(kind, `${p}.volumes[].projected.sources[].secret.name`, "K8s::Core::Secret", "mounts"),
    ref(kind, `${p}.imagePullSecrets[].name`, "K8s::Core::Secret", "pulls with"),
    ...containers.flatMap((c) => [
      ref(kind, `${c}.envFrom[].configMapRef.name`, "K8s::Core::ConfigMap", "env from"),
      ref(kind, `${c}.envFrom[].secretRef.name`, "K8s::Core::Secret", "env from"),
      ref(kind, `${c}.env[].valueFrom.configMapKeyRef.name`, "K8s::Core::ConfigMap", "env from"),
      ref(kind, `${c}.env[].valueFrom.secretKeyRef.name`, "K8s::Core::Secret", "env from"),
    ]),
    // behold#166: an env var whose value is a bucket's literal name.
    { from: kind, path: `${p}.containers[].env[].value`, targetKind: "AWS::S3::Bucket", relation: "reference", label: "uses bucket", optional: true },
  ];
}

const refs: RefRule[] = [
  // ── containment: the namespace an object is in ──
  ...NAMESPACED_KINDS.map((kind) => ref(kind, "metadata.namespace", "K8s::Core::Namespace", "in namespace", "containment")),

  // ── owner references, by name inside the namespace ──
  ...anyOf("K8s::Core::Pod", "metadata.ownerReferences[].name", ["K8s::Apps::ReplicaSet", "K8s::Apps::StatefulSet", "K8s::Apps::DaemonSet", "K8s::Batch::Job"], "owned by"),
  ...anyOf("K8s::Apps::ReplicaSet", "metadata.ownerReferences[].name", ["K8s::Apps::Deployment"], "owned by"),
  ...anyOf("K8s::Batch::Job", "metadata.ownerReferences[].name", ["K8s::Batch::CronJob"], "owned by"),

  // ── pod specs ──
  ...POD_SPECS.flatMap(([kind, p]) => podSpecRules(kind, p)),

  // ── services and ingress ──
  ...anyOf("K8s::Core::Service", "spec.selector.app", SELECTED_WORKLOADS, "selects"),
  ref("K8s::Networking::Ingress", "spec.rules[].http.paths[].backend.service.name", "K8s::Core::Service", "routes to"),
  ref("K8s::Networking::Ingress", "spec.defaultBackend.service.name", "K8s::Core::Service", "routes to"),
  ref("K8s::Networking::Ingress", "spec.tls[].secretName", "K8s::Core::Secret", "tls"),
  ref("K8s::Networking::Ingress", "spec.ingressClassName", "K8s::Networking::IngressClass", "class"),

  // ── scaling, storage, RBAC ──
  ...anyOf("K8s::Autoscaling::HorizontalPodAutoscaler", "spec.scaleTargetRef.name", ["K8s::Apps::Deployment", "K8s::Apps::StatefulSet", "K8s::Apps::ReplicaSet"], "scales"),
  ref("K8s::Core::PersistentVolumeClaim", "spec.volumeName", "K8s::Core::PersistentVolume", "bound to"),
  ref("K8s::Core::PersistentVolumeClaim", "spec.storageClassName", "K8s::Storage::StorageClass", "class"),
  ref("K8s::Core::PersistentVolume", "spec.storageClassName", "K8s::Storage::StorageClass", "class"),
  ...anyOf("K8s::Rbac::RoleBinding", "roleRef.name", ["K8s::Rbac::Role", "K8s::Rbac::ClusterRole"], "binds"),
  ...anyOf("K8s::Rbac::RoleBinding", "subjects[].name", ["K8s::Core::ServiceAccount"], "grants"),
  ...anyOf("K8s::Rbac::ClusterRoleBinding", "roleRef.name", ["K8s::Rbac::ClusterRole"], "binds"),
  ...anyOf("K8s::Rbac::ClusterRoleBinding", "subjects[].name", ["K8s::Core::ServiceAccount"], "grants"),
  ref("K8s::Core::ServiceAccount", "secrets[].name", "K8s::Core::Secret", "token"),
  ref("K8s::Core::ServiceAccount", "imagePullSecrets[].name", "K8s::Core::Secret", "pulls with"),
];

/** A namespaced object's names are unique inside its namespace (#5097). */
const scopes: ScopeRule[] = NAMESPACED_KINDS.map((kind) => ({ kind, path: "metadata.namespace" }));

export const k8sReferenceCatalog: ReferenceCatalog = { identities, refs, scopes };
