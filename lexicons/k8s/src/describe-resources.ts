/**
 * Live introspection of a Kubernetes cluster — implements the
 * LexiconPlugin.describeResources() contract for the k8s lexicon.
 *
 * For each declared K8s entity, runs `kubectl get <kind> <name> [-n <ns>] -o json`
 * and maps the response to a ResourceMetadata entry keyed by the chant entity
 * name (using the props.metadata.name + props.metadata.namespace from #39's
 * entity-prop pass-through).
 *
 * Resource-not-found is silent — `state diff --live` then reports it as
 * missing (declared, not in cloud). Unknown entity types are warn-skipped;
 * extending the KUBECTL_RESOURCE map covers more.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ResourceMetadata } from "@intentius/chant/lexicon";

const execAsync = promisify(exec);

/**
 * Map chant entity types to `kubectl get` resource names. Add entries here
 * as new types are needed.
 */
const KUBECTL_RESOURCE: Record<string, string> = {
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
}): Promise<Record<string, ResourceMetadata>> {
  const result: Record<string, ResourceMetadata> = {};
  const skippedTypes = new Set<string>();

  for (const [entityName, { entityType, props }] of options.entities) {
    const kubectlResource = KUBECTL_RESOURCE[entityType];
    if (!kubectlResource) {
      skippedTypes.add(entityType);
      continue;
    }

    const metadata = props.metadata as { name?: string; namespace?: string } | undefined;
    const name = metadata?.name;
    if (!name) continue;

    const nsArg = metadata.namespace ? ["-n", metadata.namespace] : [];
    const cmd = ["kubectl", "get", kubectlResource, name, ...nsArg, "-o", "json"].join(" ");

    try {
      const { stdout } = await execAsync(cmd);
      const obj: KubectlResponse = JSON.parse(stdout);
      result[entityName] = {
        type: entityType,
        physicalId: obj.metadata?.uid,
        status: statusFromKubectl(obj),
        lastUpdated: obj.metadata?.creationTimestamp,
        attributes: pruneUndefined({
          namespace: obj.metadata?.namespace,
          labels: obj.metadata?.labels,
          resourceVersion: obj.metadata?.resourceVersion,
        }),
      };
    } catch {
      // Resource not found / kubectl error — leave it out so state diff
      // can report it as missing. Don't fail the whole snapshot.
    }
  }

  if (skippedTypes.size > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[k8s] skipped ${skippedTypes.size} entity type(s) without kubectl mapping: ${[...skippedTypes].join(", ")}`,
    );
  }

  return result;
}
