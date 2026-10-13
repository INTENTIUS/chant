/**
 * The RBAC the collector composites grant, worked out from the collector
 * config they deploy.
 *
 * `agentClusterRules` is the ClusterRole `OtelCollector` and
 * `GkeOtelCollector` share: what the `k8sattributes` processor needs, plus
 * what the config's Kubernetes receivers need. Each rule cites the
 * component's RBAC requirements at collector-contrib v0.130.0, the version the
 * otel lexicon pins.
 *
 * `namespacedRoles` builds one Role and RoleBinding per namespace, for access
 * a collector needs in namespaces other than its own: Endpoints for a
 * `loadbalancing` exporter's `k8s` resolver, Leases for a
 * `k8s_leader_elector` extension.
 */

import { mergeDefaults } from "@intentius/chant";
import type { CollectorConfig } from "@intentius/chant-lexicon-otel";
import { canonicalTypeOf, type ComponentKind } from "@intentius/chant-lexicon-otel/model";
import { Role, RoleBinding } from "../generated";
import type { MemberDefaults } from "./member-defaults";

/** One RBAC rule, as a Role or ClusterRole lists it. */
export interface CollectorPolicyRule {
  apiGroups: string[];
  resources: string[];
  verbs: string[];
  resourceNames?: string[];
}

const READ = ["get", "list", "watch"];

/** The configs of the components of `kind` whose type is `type`, under its old or new name (`k8s_attributes`). */
function componentsOfType(kind: ComponentKind, section: Record<string, unknown> | undefined, type: string): Array<Record<string, unknown>> {
  return Object.entries(section ?? {})
    .filter(([id]) => canonicalTypeOf(kind, id) === type)
    .map(([, cfg]) => (cfg && typeof cfg === "object" ? (cfg as Record<string, unknown>) : {}));
}

/**
 * The agent ClusterRole's rules for a collector config.
 *
 * Always, for `k8sattributes` (processor/k8sattributesprocessor README,
 * "Cluster-scoped RBAC"): `get`, `list` and `watch` on pods, namespaces and
 * nodes, and on `apps` replicasets for `k8s.deployment.name`, which is
 * extracted by default. The processor lists ReplicaSets through `apps/v1`
 * only, so the README's `extensions` group is left out. When a
 * `k8sattributes` processor extracts labels or annotations `from: deployment`,
 * `apps` deployments are added.
 *
 * For each `kubeletstats` receiver (receiver/kubeletstatsreceiver README,
 * "Role-based access control"): `get` on `nodes/stats`; `get` on
 * `nodes/proxy` when it sets `extra_metadata_labels` or enables a
 * `*_request_utilization` or `*_limit_utilization` metric; and, when it sets
 * `k8s_api_config`, `get` on persistentvolumeclaims and persistentvolumes,
 * which it reads for volume metadata (scraper.go).
 *
 * Other components that read the Kubernetes API, such as `k8s_cluster`
 * (which belongs on a gateway, see WK8603), add their rules through
 * `defaults.clusterRole.rules`, which are appended.
 */
export function agentClusterRules(config: CollectorConfig): CollectorPolicyRule[] {
  const apps = ["replicasets"];
  const k8sattributes = componentsOfType("processor", config.processors as Record<string, unknown> | undefined, "k8sattributes");
  const fromDeployment = k8sattributes.some((p) => {
    const extract = p.extract as { labels?: Array<{ from?: string }>; annotations?: Array<{ from?: string }> } | undefined;
    return [...(extract?.labels ?? []), ...(extract?.annotations ?? [])].some((f) => f?.from === "deployment");
  });
  if (fromDeployment) apps.push("deployments");

  const rules: CollectorPolicyRule[] = [
    { apiGroups: [""], resources: ["pods", "namespaces", "nodes"], verbs: READ },
    { apiGroups: ["apps"], resources: apps, verbs: READ },
  ];

  const kubeletstats = componentsOfType("receiver", config.receivers as Record<string, unknown> | undefined, "kubeletstats");
  if (kubeletstats.length) {
    const nodeSubresources = ["nodes/stats"];
    const needsProxy = kubeletstats.some((r) => {
      const labels = r.extra_metadata_labels;
      if (Array.isArray(labels) && labels.length) return true;
      const metrics = (r.metrics ?? {}) as Record<string, { enabled?: boolean } | undefined>;
      return Object.entries(metrics).some(([metric, toggle]) => /_(request|limit)_utilization$/.test(metric) && toggle?.enabled === true);
    });
    if (needsProxy) nodeSubresources.push("nodes/proxy");
    rules.push({ apiGroups: [""], resources: nodeSubresources, verbs: ["get"] });
    if (kubeletstats.some((r) => r.k8s_api_config)) {
      rules.push({ apiGroups: [""], resources: ["persistentvolumeclaims", "persistentvolumes"], verbs: ["get"] });
    }
  }

  return rules;
}

function pascal(namespace: string): string {
  return namespace
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

export interface NamespacedRolesOptions {
  /** Prefix of the member names: `<key>Role` and `<key>RoleBinding`. */
  key: string;
  /** Name of each Role and RoleBinding. They live in different namespaces, so one name serves all. */
  name: string;
  /** Namespaces to grant in, in declaration order. */
  namespaces: string[];
  rules: CollectorPolicyRule[];
  labels: Record<string, string>;
  /** The ServiceAccount every RoleBinding binds. */
  serviceAccount: { name: string; namespace: string };
  /** Defaults laid over each Role and each RoleBinding. */
  roleDefaults?: MemberDefaults<"Role">;
  roleBindingDefaults?: MemberDefaults<"RoleBinding">;
}

/**
 * One Role and RoleBinding per namespace, as composite members. The first
 * namespace's are `<key>Role` and `<key>RoleBinding`, so a single-namespace
 * config keeps the member names it had before; each further namespace's are
 * `<key>RoleIn<Namespace>` and `<key>RoleBindingIn<Namespace>`, with the
 * namespace in PascalCase (`team-a` gives `endpointsRoleInTeamA`).
 */
export function namespacedRoles(opts: NamespacedRolesOptions): Record<string, InstanceType<typeof Role> | InstanceType<typeof RoleBinding>> {
  const out: Record<string, InstanceType<typeof Role> | InstanceType<typeof RoleBinding>> = {};
  const seen = new Map<string, string>();
  opts.namespaces.forEach((namespace, i) => {
    const suffix = i === 0 ? "" : `In${pascal(namespace)}`;
    const clash = seen.get(suffix);
    if (clash !== undefined) {
      throw new Error(`${opts.name}: namespaces ${clash} and ${namespace} give the same member name ${opts.key}Role${suffix}`);
    }
    seen.set(suffix, namespace);
    out[`${opts.key}Role${suffix}`] = new Role(mergeDefaults({
      metadata: { name: opts.name, namespace, labels: opts.labels },
      rules: opts.rules,
    }, opts.roleDefaults));
    out[`${opts.key}RoleBinding${suffix}`] = new RoleBinding(mergeDefaults({
      metadata: { name: opts.name, namespace, labels: opts.labels },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: opts.name },
      subjects: [{ kind: "ServiceAccount", name: opts.serviceAccount.name, namespace: opts.serviceAccount.namespace }],
    }, opts.roleBindingDefaults));
  });
  return out;
}
