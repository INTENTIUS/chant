import type { IRNode } from "@intentius/chant/graph-ir";
import { k8sDeclaredNode, registersCluster } from "./cluster-secret";
import { APPLICATION, APPLICATION_SET, generateApplications } from "./application-set";
import { applicationPathRules } from "./application-paths";
import { readPath, type GenerateRule, type IdentityRule, type JoinedRef, type ReferenceCatalog, type RefRule, type ScopeRule } from "@intentius/chant/graph-refs";

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
 * ## External Secrets (#5098)
 *
 * An `ExternalSecret` names a store, and through it a secret in a cloud
 * secret manager. Both are rules with a `join`, since neither is one value
 * naming one node. The store rule reads `spec.secretStoreRef.name` as a
 * `SecretStore` in the holder's namespace or a cluster-scoped
 * `ClusterSecretStore`, as `spec.secretStoreRef.kind` says (absent is
 * `SecretStore`, the operator's default): one rule per kind, each reading
 * only the references of its own. The secret rule reads
 * `spec.data[].remoteRef.key` and `spec.dataFrom[].extract.key` and joins
 * the key to the cloud secret inside the scope the store names: a GCP store's
 * `projectID` with a `google_secret_manager_secret`'s `secret_id` and
 * `project`, an AWS Secrets Manager store's `region` with an
 * `aws_secretsmanager_secret`'s `name`. The edge's `viaAttr` is
 * `remoteRef.key via <store name>`, and a key that names no secret is
 * dangling with the store's node as `through`. A store that is not found
 * is dangling under the store rule, and its keys are not read. A Terraform
 * argument that is not literal is not read (the pass counts it), so a secret
 * whose `secret_id` or `project` is a variable matches nothing. An AWS secret
 * matches on its name alone when it sets no literal `region`.
 *
 * ## Argo CD clusters (#5101)
 *
 * An Application's `spec.destination.name` or `.server` joins the cluster
 * Secret whose `name` or `server` it is, and a cluster Secret's `name` joins
 * the managed Kubernetes cluster block of that literal name in the terraform
 * catalog. The Secret's values are read from `argoCluster` (./cluster-secret.ts),
 * which only a cluster Secret has, decoded from `data` when it wrote them
 * there. Application is scoped by `metadata.namespace` like the Secret, but is
 * not a named kind, so it has no containment rule to a Namespace.
 *
 * ## ApplicationSets (#5102)
 *
 * An ApplicationSet's `list` and `clusters` generators are expanded into the
 * Applications they generate (./application-set.ts), one node each, under the
 * `generates` rule. An Application a `clusters` generator made for a cluster
 * Secret joins that Secret under `generators[].clusters`, since the
 * generator selected it; the destination rules draw no second edge for the
 * pair. The other rules read a generated Application as one written by hand. The path rules
 * (./application-paths.ts) read the directories and values files every
 * Application names, and the pass lists one the repository does not have as
 * dangling.
 *
 * ## What this does not do
 *
 * - Stores other than GCP and AWS Secrets Manager (IBM, Vault), the legacy
 *   `kubernetes-client.io` ExternalSecret, and the Secret an ExternalSecret
 *   writes (`spec.target.name`).
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
 * ## Helm values files (#5100)
 *
 * An Argo CD Application or ApplicationSet and a kustomization with
 * `helmCharts` name their values files in `helmReferences.valuesFiles[]`, a
 * key the reader stamps with each file's workspace-relative path
 * (./helm-references.ts). A file that exists and parses is a `Helm::Values`
 * node identified by that path, so a name with no node is dangling with the
 * path. The edges to the charts are not rules here: a chart is shared by every
 * member that names it, so the helm lexicon's catalog makes the node.
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

/**
 * Namespaced kinds that are scoped and named but draw no `in namespace`
 * containment (#5098): an ExternalSecret and a SecretStore reach a store by
 * name inside their namespace, and a report of every one whose Namespace is
 * declared nowhere would bury the references this catalog is for.
 */
const SCOPED_KINDS = ["K8s::ExternalSecrets::ExternalSecret", "K8s::ExternalSecrets::SecretStore"];

/** Kinds other objects name by `metadata.name`. */
const NAMED_KINDS = [
  ...NAMESPACED_KINDS,
  ...SCOPED_KINDS,
  "K8s::Core::Namespace",
  "K8s::Core::PersistentVolume",
  "K8s::Networking::IngressClass",
  "K8s::Storage::StorageClass",
  "K8s::Rbac::ClusterRole",
  "K8s::ExternalSecrets::ClusterSecretStore",
];

/** Workloads whose pod template a Service's `app` selector can match. */
const SELECTED_WORKLOADS = ["K8s::Apps::Deployment", "K8s::Apps::StatefulSet", "K8s::Apps::DaemonSet"];

/**
 * What else names a kind, beyond `metadata.name`: a workload by its pod
 * template's `app` label, and a Secret by the `name` and `server` an Argo CD
 * cluster registration holds (#5101). `k8sDeclaredNode` (./cluster-secret.ts)
 * puts them under `argoCluster` on a cluster Secret and on no other, so a
 * Secret with a `stringData.name` of its own is not read as one.
 */
const EXTRA_IDS: Record<string, string[]> = {
  ...Object.fromEntries(SELECTED_WORKLOADS.map((kind) => [kind, ["spec.template.metadata.labels.app"]])),
  "K8s::Core::Secret": ["argoCluster.name", "argoCluster.server"],
};

/** Objects that can name a chart and the values files for it (#5100); the reader stamps `helmReferences` on them (./helm-references.ts). */
const HELM_HOLDERS = ["K8s::Argo::Application", "K8s::Argo::ApplicationSet", "K8s::Kustomize::Kustomization"];

const identities: IdentityRule[] = [
  ...NAMED_KINDS.map((kind) => ({ kind, ids: ["metadata.name", ...(EXTRA_IDS[kind] ?? [])] })),
  // A values file is the helm lexicon's node, read by this lexicon's reader and named by its workspace-relative path (#5100).
  { kind: "Helm::Values", ids: ["path"] },
];

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

const EXTERNAL_SECRET = "K8s::ExternalSecrets::ExternalSecret";
const STORE_KINDS = ["K8s::ExternalSecrets::SecretStore", "K8s::ExternalSecrets::ClusterSecretStore"] as const;
const SECRET_KEY_PATHS = ["spec.data[].remoteRef.key", "spec.dataFrom[].extract.key"] as const;

const first = (node: IRNode, path: string): string | undefined => readPath(node.attrs, path).find((v) => v !== "");

/** The store kind an ExternalSecret names: `SecretStore` unless it says otherwise. */
const storeKindOf = (holder: IRNode): string => `K8s::ExternalSecrets::${first(holder, "spec.secretStoreRef.kind") ?? "SecretStore"}`;

/** The store rule for one store kind: reads only the ExternalSecrets that name a store of that kind. */
function storeRule(targetKind: (typeof STORE_KINDS)[number]): RefRule {
  return {
    from: EXTERNAL_SECRET,
    path: "spec.secretStoreRef.name",
    targetKind,
    relation: "reference",
    label: "reads through",
    join(holder, find) {
      const name = first(holder, "spec.secretStoreRef.name");
      if (name === undefined || storeKindOf(holder) !== targetKind) return [];
      return [{ value: name, targets: find(name).filter((n) => n.kind === targetKind), via: "secretStoreRef" }];
    },
  };
}

/** The one store an ExternalSecret reads through, or undefined when it is missing or ambiguous (the store rule reports that). */
function storeOf(holder: IRNode, find: (value: string) => readonly IRNode[]): IRNode | undefined {
  const name = first(holder, "spec.secretStoreRef.name");
  if (name === undefined) return undefined;
  const stores = find(name).filter((n) => n.kind === storeKindOf(holder));
  return stores.length === 1 ? stores[0] : undefined;
}

/**
 * The secret rule for one key path and one secret manager: the cloud secret a
 * key names inside the scope its store names, `inScope` deciding what counts
 * as inside. Reads only the ExternalSecrets whose store is of `provider`.
 */
function secretRule(path: string, targetKind: string, provider: (store: IRNode) => string | undefined, inScope: (secret: IRNode, scope: string) => boolean): RefRule {
  return {
    from: EXTERNAL_SECRET,
    path,
    targetKind,
    relation: "reference",
    label: "reads secret",
    join(holder, find) {
      const store = storeOf(holder, find);
      const scope = store && provider(store);
      if (!store || scope === undefined) return [];
      const refs: JoinedRef[] = [];
      for (const key of new Set(readPath(holder.attrs, path))) {
        const targets = find(key).filter((n) => n.kind === targetKind && inScope(n, scope));
        refs.push({ value: key, targets, via: `remoteRef.key via ${first(store, "metadata.name") ?? store.id}`, through: store });
      }
      return refs;
    },
  };
}

const gcpProject = (store: IRNode) => first(store, "spec.provider.gcpsm.projectID");
const awsRegion = (store: IRNode) => (first(store, "spec.provider.aws.service") === "SecretsManager" ? first(store, "spec.provider.aws.region") : undefined);

const externalSecretRules: RefRule[] = [
  ...STORE_KINDS.map(storeRule),
  ...SECRET_KEY_PATHS.flatMap((path) => [
    secretRule(path, "google_secret_manager_secret", gcpProject, (secret, project) => first(secret, "project") === project),
    // The resource sets `region` only when it is not the provider's, so an AWS secret without one matches on its name.
    secretRule(path, "aws_secretsmanager_secret", awsRegion, (secret, region) => (first(secret, "region") ?? region) === region),
  ]),
];
/**
 * The cloud kinds a cluster Secret's `name` can be the literal name of (#5101).
 * The `registers` rule has one entry per kind under one id, so the Secret
 * dangles only when no kind matches.
 */
const CLUSTER_KINDS = ["google_container_cluster", "aws_eks_cluster", "azurerm_kubernetes_cluster"];

const SERVICE_ACCOUNT = "K8s::Core::ServiceAccount";
export const GKE_ANNOTATION = 'metadata.annotations["iam.gke.io/gcp-service-account"]';
export const EKS_ANNOTATION = 'metadata.annotations["eks.amazonaws.com/role-arn"]';

const GCP_EMAIL = /^([a-z][a-z0-9-]*)@([a-z][a-z0-9-]*)\.iam\.gserviceaccount\.com$/i;
const AWS_ROLE_ARN = /^arn:aws[a-z-]*:iam::(\d{12}):role\/(?:(.*)\/)?([^/]+)$/;

/**
 * The cloud identity a ServiceAccount's annotation names (#5099). Neither
 * value is one identifier a target carries, so both are rules with a `join`:
 *
 * - GKE Workload Identity, `iam.gke.io/gcp-service-account`. The email is
 *   `<account_id>@<project>.iam.gserviceaccount.com`, and a
 *   `google_service_account` declares those two arguments while its email is
 *   computed. The rule finds the account by `account_id` and keeps the ones
 *   whose literal `project` is the email's, so two accounts of one id in
 *   different projects are told apart.
 * - EKS IRSA, `eks.amazonaws.com/role-arn`. The role is found by the last
 *   segment of the ARN, kept when its literal `path` agrees with the ARN's
 *   and, if its literal `arn` is set, the account id agrees too. Terraform
 *   does not hold the account id otherwise, so a role with no `arn` argument
 *   is matched on its name and path.
 *
 * A value of another shape names no node, so it is dangling.
 */
const identityRules: RefRule[] = [
  {
    from: SERVICE_ACCOUNT,
    path: GKE_ANNOTATION,
    targetKind: "google_service_account",
    relation: "reference",
    label: "acts as",
    join(holder, find) {
      const email = first(holder, GKE_ANNOTATION);
      if (email === undefined) return [];
      const m = GCP_EMAIL.exec(email);
      const targets = m ? find(m[1]).filter((n) => n.kind === "google_service_account" && first(n, "account_id") === m[1] && first(n, "project") === m[2]) : [];
      return [{ value: email, targets, via: "iam.gke.io/gcp-service-account" }];
    },
  },
  {
    from: SERVICE_ACCOUNT,
    path: EKS_ANNOTATION,
    targetKind: "aws_iam_role",
    relation: "reference",
    label: "acts as",
    join(holder, find) {
      const arn = first(holder, EKS_ANNOTATION);
      if (arn === undefined) return [];
      const m = AWS_ROLE_ARN.exec(arn);
      const targets = m
        ? find(m[3]).filter((n) => {
            if (n.kind !== "aws_iam_role" || first(n, "name") !== m[3]) return false;
            const path = first(n, "path");
            if (path !== undefined && path.replace(/^\/|\/$/g, "") !== (m[2] ?? "")) return false;
            const own = first(n, "arn")?.match(/^arn:aws[a-z-]*:iam::(\d{12}):/);
            return own === null || own === undefined || own[1] === m[1];
          })
        : [];
      return [{ value: arn, targets, via: "eks.amazonaws.com/role-arn" }];
    },
  },
];

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

  // ── Argo CD (#5101): where an Application deploys, and the cluster a registration names ──
  ...anyOf("K8s::Argo::Application", "spec.destination.name", ["K8s::Core::Secret"], "deploys to"),
  ...anyOf("K8s::Argo::Application", "spec.destination.server", ["K8s::Core::Secret"], "deploys to"),
  ...CLUSTER_KINDS.map((kind) => ref("K8s::Core::Secret", "argoCluster.name", kind, "registers")),

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

  // ── External Secrets: the store, and the cloud secret through it ──
  ...externalSecretRules,

  // ── cloud identity: the account a ServiceAccount acts as ──
  ...identityRules,

  // ── Helm values files (#5100): a path that names no file is dangling ──
  ...HELM_HOLDERS.map((kind) => ref(kind, "helmReferences.valuesFiles[]", "Helm::Values", "values")),
];

/** A namespaced object's names are unique inside its namespace (#5097). */
const scopes: ScopeRule[] = [
  ...[...NAMESPACED_KINDS, ...SCOPED_KINDS, "K8s::Argo::Application"].map((kind) => ({ kind, path: "metadata.namespace" })),
  // A values file is read once per member that names it, and is held by that member alone: every holder reaches the one in its own member (#5100).
  { kind: "Helm::Values" },
];

/** An ApplicationSet's generated Applications (#5102). */
const generates: GenerateRule[] = [
  {
    from: APPLICATION_SET,
    path: "spec.generators",
    targetKind: APPLICATION,
    label: "generates",
    generate: generateApplications,
    // A clusters generator selected the Secret, so the generated Application deploys to it whatever namespace either sits in.
    cluster: { path: "generators[].clusters", targetKind: "K8s::Core::Secret", label: "deploys to" },
  },
];

export const k8sReferenceCatalog: ReferenceCatalog = { identities, refs, scopes, declaredNode: k8sDeclaredNode, registersCluster, generates, pathRefs: applicationPathRules };
