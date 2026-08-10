/**
 * Deploy-unit status for Kubernetes (#1495 piece 3).
 *
 * A Kubernetes deploy unit *is* a label selector: every object chant applies
 * carries its stack identity in the labels the serializer stamps
 * (`app.kubernetes.io/managed-by=chant`, `chant.intentius.io/stack=<stack>` —
 * see core's ownership marking). So "is this unit present" is one selector
 * query, and "is it healthy" is whether every matching workload its controller
 * reports on is Ready. No new identity concept — this reads back exactly what
 * `kubectl-apply` (piece 2) and the serializer already write.
 *
 * The selector deliberately omits `chant.intentius.io/env`: `ownership.env` is
 * a config identity stamped at synthesis, not necessarily the environment name
 * a caller observes with, and a mismatch would read a deployed unit as absent
 * — the failure mode the tri-state exists to prevent.
 *
 * The sweep starts from the kinds chant's own k8s surface deploys as
 * stack-scoped objects (workloads + the service/config plumbing around them),
 * then widens to what the cluster itself serves: the CRDs (a unit that
 * deploys definitions is a real unit — kubemicrovm-ops pins them
 * `delete: never`), and every CRD-backed kind those definitions declare. A
 * kubemicrovm workload stack is *entirely* custom resources, and under the
 * fixed bound it read as absent while its VMs ran (#1528) — and because a
 * component is live only when every unit is, that one false absence painted
 * whole components dead. The CRD list is read unfiltered, since the unit
 * under observation rarely owns the definitions its objects instantiate;
 * each derived kind is then read with the same stack selector, so the cost
 * is one label-filtered list per served CRD kind.
 */
import type { StackStatusObservation } from "@intentius/chant/lexicon";
import { LABEL_OWNERSHIP_KEYS, OWNERSHIP_MANAGED_BY_VALUE } from "@intentius/chant/ownership";
import type { K8sObject } from "@intentius/chant-k8s-client";
import { defaultK8sConnector, type K8sConnector } from "./api/connect";

/** The kinds a chant-applied stack's objects land as — the sweep's bound. */
const SWEEP_KINDS: ReadonlyArray<{ apiVersion: string; kind: string }> = [
  { apiVersion: "apps/v1", kind: "Deployment" },
  { apiVersion: "apps/v1", kind: "StatefulSet" },
  { apiVersion: "apps/v1", kind: "DaemonSet" },
  { apiVersion: "v1", kind: "Service" },
  { apiVersion: "v1", kind: "ConfigMap" },
  { apiVersion: "v1", kind: "Secret" },
  { apiVersion: "v1", kind: "ServiceAccount" },
  { apiVersion: "v1", kind: "Namespace" },
  { apiVersion: "networking.k8s.io/v1", kind: "Ingress" },
  { apiVersion: "policy/v1", kind: "PodDisruptionBudget" },
  { apiVersion: "autoscaling/v2", kind: "HorizontalPodAutoscaler" },
  { apiVersion: "batch/v1", kind: "CronJob" },
  // The definitions themselves: a crds unit deploys these and nothing else.
  { apiVersion: "apiextensions.k8s.io/v1", kind: "CustomResourceDefinition" },
];

/**
 * Every kind the cluster's CRDs declare, one served version each (storage
 * preferred). Read unfiltered — see the module doc. Failure to read the CRD
 * list narrows the sweep back to the fixed bound rather than failing it.
 */
async function crdBackedKinds(client: {
  list(target: { apiVersion: string; kind: string }, opts?: object): Promise<K8sObject[]>;
}): Promise<Array<{ apiVersion: string; kind: string }>> {
  let crds: K8sObject[];
  try {
    crds = await client.list({ apiVersion: "apiextensions.k8s.io/v1", kind: "CustomResourceDefinition" });
  } catch {
    return [];
  }
  const kinds: Array<{ apiVersion: string; kind: string }> = [];
  for (const crd of crds) {
    const spec = (crd as {
      spec?: {
        group?: string;
        names?: { kind?: string };
        versions?: Array<{ name: string; served?: boolean; storage?: boolean }>;
      };
    }).spec;
    const group = spec?.group;
    const kind = spec?.names?.kind;
    const versions = spec?.versions ?? [];
    const version = versions.find((v) => v.storage && v.served) ?? versions.find((v) => v.served);
    if (!group || !kind || !version) continue;
    kinds.push({ apiVersion: `${group}/${version.name}`, kind });
  }
  return kinds;
}

/** A workload is healthy when its controller reports every replica ready; a
 * kind with no readiness story (a ConfigMap, a Service) asserts nothing. */
function objectHealthy(obj: K8sObject): boolean | undefined {
  const status = obj.status as { replicas?: unknown; readyReplicas?: unknown; desiredNumberScheduled?: unknown; numberReady?: unknown } | undefined;
  if (!status) return undefined;
  if (typeof status.replicas === "number") {
    return (typeof status.readyReplicas === "number" ? status.readyReplicas : 0) >= status.replicas;
  }
  if (typeof status.desiredNumberScheduled === "number") {
    return (typeof status.numberReady === "number" ? status.numberReady : 0) >= status.desiredNumberScheduled;
  }
  return undefined;
}

export async function describeStackStatus(
  options: { environment: string; stack: string },
  connect: K8sConnector = defaultK8sConnector,
): Promise<StackStatusObservation | null> {
  const selector =
    `${LABEL_OWNERSHIP_KEYS.managedBy}=${OWNERSHIP_MANAGED_BY_VALUE},` +
    `${LABEL_OWNERSHIP_KEYS.stack}=${options.stack}`;

  let client;
  try {
    ({ client } = await connect({ environment: options.environment }));
  } catch {
    // No cluster binding / unreadable kubeconfig — indeterminate, never a
    // confident "not there".
    return null;
  }

  const matched: K8sObject[] = [];
  let anyRead = false;
  const targets = [...SWEEP_KINDS, ...(await crdBackedKinds(client))];
  for (const target of targets) {
    try {
      const items = await client.list(target, { labelSelector: selector });
      anyRead = true;
      matched.push(...items);
    } catch {
      // One kind's list failing (RBAC, an aggregated API down) proves nothing
      // about the others; keep sweeping.
    }
  }
  if (!anyRead) return null; // every read failed — indeterminate

  if (matched.length === 0) return { stack: options.stack, present: false };

  const verdicts = matched.map(objectHealthy).filter((v): v is boolean => v !== undefined);
  const healthy = verdicts.length > 0 ? verdicts.every(Boolean) : true;
  const ready = verdicts.filter(Boolean).length;
  return {
    stack: options.stack,
    present: true,
    status: verdicts.length > 0 ? `${ready}/${verdicts.length} workloads ready` : `${matched.length} objects present`,
    healthy,
  };
}
