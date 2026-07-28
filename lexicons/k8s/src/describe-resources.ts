/**
 * Live introspection of a Kubernetes cluster — implements the
 * LexiconPlugin.describeResources() contract for the k8s lexicon.
 *
 * For each declared K8s entity, runs `kubectl get <kind> <name> [-n <ns>] -o json`
 * and maps the response to a ResourceMetadata entry keyed by the chant entity
 * name (using the props.metadata.name + props.metadata.namespace from #39's
 * entity-prop pass-through).
 *
 * The observation tri-state (#1089) is what the return value carries. A genuine
 * `NotFound` from the API server is an absence, and only that becomes a `create`
 * downstream. An entity type with no entry in `KUBECTL_RESOURCE` — every CRD —
 * was never looked at, and comes back `unsupported-kind`: it may well be running
 * in the cluster, and proposing to create it would be a guess. Auth failures and
 * unreachable API servers come back `no-credentials` / `no-binding` for the same
 * reason. Extending the KUBECTL_RESOURCE map converts unsupported-kind holes into
 * real reads; until then they are holes chant admits to.
 *
 * Before touching any resource, the environment is resolved to a cluster
 * identity (chant #1100) via `resolveClusterTarget` — see `./config.ts` for
 * the `k8s.profiles.<env>.context` binding shape. A declared binding is
 * passed explicitly as `--context` on every kubectl call below; an ambient
 * context that disagrees with it aborts the whole describe with a loud
 * error rather than silently reading the wrong cluster. No binding keeps
 * today's behavior (ambient context), with a visible warning.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ObservationResult, ResourceMetadata, UnobservedEntity } from "@intentius/chant/lexicon";
import { observation } from "@intentius/chant/observation";
import { hasOwnershipMarker, classifyOwnership, LABEL_OWNERSHIP_KEYS } from "@intentius/chant/ownership";
import { loadChantConfig } from "@intentius/chant/config";
import { resolveClusterTarget, classifyKubectlFailure } from "@intentius/chant/kubectl-context";

const execAsync = promisify(exec);

/**
 * Map chant entity types to `kubectl get` resource names. Add entries here
 * as new types are needed.
 */
export const KUBECTL_RESOURCE: Record<string, string> = {
  "K8s::Apps::Deployment": "deployment.apps",
  "K8s::Apps::StatefulSet": "statefulset.apps",
  "K8s::Apps::DaemonSet": "daemonset.apps",
  "K8s::Apps::ReplicaSet": "replicaset.apps",
  "K8s::Core::Service": "service",
  "K8s::Core::ConfigMap": "configmap",
  "K8s::Core::Secret": "secret",
  "K8s::Core::Namespace": "namespace",
  "K8s::Core::Pod": "pod",
  "K8s::Core::PersistentVolumeClaim": "persistentvolumeclaim",
  "K8s::Core::ServiceAccount": "serviceaccount",
  "K8s::Batch::Job": "job.batch",
  "K8s::Batch::CronJob": "cronjob.batch",
  "K8s::Networking::Ingress": "ingress.networking.k8s.io",
  "K8s::Networking::NetworkPolicy": "networkpolicy.networking.k8s.io",
  "K8s::Rbac::Role": "role.rbac.authorization.k8s.io",
  "K8s::Rbac::RoleBinding": "rolebinding.rbac.authorization.k8s.io",
  "K8s::Rbac::ClusterRole": "clusterrole.rbac.authorization.k8s.io",
  "K8s::Rbac::ClusterRoleBinding": "clusterrolebinding.rbac.authorization.k8s.io",
};

interface KubectlResponse {
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    resourceVersion?: string;
  };
  status?: {
    phase?: string;
    [k: string]: unknown;
  };
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function statusFromKubectl(obj: KubectlResponse): string {
  // Different K8s resource types report status differently. Fall back to
  // "PRESENT" if we can't extract a meaningful field.
  const phase = obj.status?.phase;
  if (typeof phase === "string") return phase;
  // Deployment/StatefulSet — readyReplicas == replicas → READY
  const status = obj.status as Record<string, unknown> | undefined;
  if (status && typeof status.readyReplicas === "number" && typeof status.replicas === "number") {
    return status.readyReplicas === status.replicas ? "READY" : `PROGRESSING(${status.readyReplicas}/${status.replicas})`;
  }
  return "PRESENT";
}

export async function describeResources(options: {
  environment: string;
  buildOutput: string;
  entityNames: string[];
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
  owned?: boolean;
}): Promise<ObservationResult> {
  const result: Record<string, ResourceMetadata> = {};
  const unobserved: Record<string, UnobservedEntity> = {};
  const skippedTypes = new Set<string>();

  // Resolve the cluster identity for this environment before touching any
  // resource — a declared-but-mismatched binding throws here, aborting the
  // whole describe rather than letting a per-entity try/catch below absorb
  // it as an ordinary "not found".
  const { config } = await loadChantConfig(process.cwd());
  const target = await resolveClusterTarget(config as Record<string, unknown>, options.environment, "k8s");
  const ctxArg = target.context ? ["--context", target.context] : [];

  for (const [entityName, { entityType, props }] of options.entities) {
    const kubectlResource = KUBECTL_RESOURCE[entityType];
    if (!kubectlResource) {
      // No reader for this kind (every CRD). The object may exist; chant has no
      // way to ask. Reporting it as unobserved is what stops `lifecycle plan`
      // proposing to create a CRD that is already in the cluster (#1089).
      skippedTypes.add(entityType);
      unobserved[entityName] = {
        type: entityType,
        reason: "unsupported-kind",
        detail: `no kubectl mapping for ${entityType} — extend KUBECTL_RESOURCE to observe it`,
      };
      continue;
    }

    const metadata = props.metadata as { name?: string; namespace?: string } | undefined;
    const name = metadata?.name;
    if (!name) {
      // Nothing to query by. Not an absence — chant never issued a read.
      unobserved[entityName] = {
        type: entityType,
        reason: "read-failed",
        detail: "declared entity has no metadata.name to query by",
      };
      continue;
    }

    const nsArg = metadata.namespace ? ["-n", metadata.namespace] : [];
    const cmd = ["kubectl", "get", kubectlResource, name, ...nsArg, ...ctxArg, "-o", "json"].join(" ");

    try {
      const { stdout } = await execAsync(cmd);
      const obj: KubectlResponse = JSON.parse(stdout);
      // owned filter: withhold resources not carrying chant's marker label.
      // Withheld is not absent (#1089) — this object exists, it just isn't
      // chant's, and dropping it silently is how `--owned` used to turn a
      // declared-but-foreign resource into a proposed `create`.
      if (options.owned && !hasOwnershipMarker(obj.metadata?.labels, LABEL_OWNERSHIP_KEYS)) {
        unobserved[entityName] = {
          type: entityType,
          reason: "filtered",
          detail: "live object carries no chant ownership marker and --owned was requested",
        };
        continue;
      }
      result[entityName] = {
        type: entityType,
        physicalId: obj.metadata?.uid,
        status: statusFromKubectl(obj),
        lastUpdated: obj.metadata?.creationTimestamp,
        ownership: classifyOwnership(obj.metadata?.labels, LABEL_OWNERSHIP_KEYS),
        attributes: pruneUndefined({
          namespace: obj.metadata?.namespace,
          labels: obj.metadata?.labels,
          resourceVersion: obj.metadata?.resourceVersion,
        }),
      };
    } catch (err) {
      // Only a real NotFound leaves the entity out (an absence the diff may
      // read as missing and the plan as create). Auth, connectivity, and every
      // other failure prove nothing about existence and are reported as such.
      const outcome = classifyKubectlFailure(err);
      if (outcome.kind === "unobserved") {
        unobserved[entityName] = { type: entityType, reason: outcome.reason, detail: outcome.detail };
      }
    }
  }

  if (skippedTypes.size > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[k8s] no kubectl mapping for ${skippedTypes.size} entity type(s): ${[...skippedTypes].join(", ")} — reported as unobserved (not absent), so no create is proposed for them`,
    );
  }

  return observation(result, unobserved);
}
