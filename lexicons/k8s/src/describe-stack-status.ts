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
 * The sweep is bounded to the kinds chant's own k8s surface deploys as
 * stack-scoped objects (workloads + the service/config plumbing around them).
 * A CRD-only unit is out of this bound and reports absent rather than null —
 * a real limit, stated here rather than papered over; widening the sweep to
 * discovery-driven kinds is a follow-up, not a silent claim.
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
];

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
  for (const target of SWEEP_KINDS) {
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
