/**
 * Live introspection of a GCP project via Config Connector CRDs.
 *
 * GCP entities in chant are emitted as Config Connector custom resources
 * (apiVersion <service>.cnrm.cloud.google.com/v1beta1, kind <Service><Kind>).
 * To observe them at runtime we shell out to kubectl against a Config
 * Connector-enabled cluster — the same pattern as the K8s lexicon.
 *
 *   GCP::Storage::Bucket    → kubectl get storagebucket.storage.cnrm.cloud.google.com
 *   GCP::Compute::Subnetwork → kubectl get computesubnetwork.compute.cnrm.cloud.google.com
 *
 * Resource-not-found is an absence — `state diff --live` reports it as missing.
 * Everything else the kubectl call can fail with (auth, an unreachable API
 * server, an entity type with no derivable GVK) is NOT-OBSERVED (#1089), so a
 * read that never happened cannot become a proposed `create`.
 *
 * Since this reads Config Connector CRDs through the same kubectl path as
 * the K8s lexicon, it resolves the same environment→cluster binding (chant
 * #1100) via `resolveClusterTarget` — `k8s.profiles.<env>.context` in
 * `chant.config.ts` (see `lexicons/k8s/src/config.ts`), not a separate
 * `gcp.profiles` key, because it is fundamentally the same kubectl context a
 * project's K8s entities would use against the same cluster.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ObservationResult, ResourceMetadata, UnobservedEntity } from "@intentius/chant/lexicon";
import { observation } from "@intentius/chant/observation";
import { hasOwnershipMarker, classifyOwnership, LABEL_OWNERSHIP_KEYS } from "@intentius/chant/ownership";
import { loadChantConfig } from "@intentius/chant/config";
import { resolveClusterTarget, classifyKubectlFailure } from "@intentius/chant/kubectl-context";

const execAsync = promisify(exec);

interface KubectlResponse {
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  status?: {
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
    [k: string]: unknown;
  };
}

/**
 * Mirror of `lexicons/gcp/src/serializer.ts:deriveGVKFromType` — keeping the
 * derivation logic local so describeResources can compute the kubectl resource
 * name without importing serializer internals.
 */
export function deriveGVK(entityType: string): { group: string; kind: string } | null {
  const parts = entityType.split("::");
  if (parts.length !== 3 || parts[0] !== "GCP") return null;
  const service = parts[1].toLowerCase();
  const shortKind = parts[2];
  return {
    group: `${service}.cnrm.cloud.google.com`,
    kind: `${parts[1]}${shortKind}`,
  };
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Config Connector encodes deployment state as a `Ready` condition on the
 * resource's status. Fall back to listing all condition types if `Ready`
 * isn't present.
 */
function statusFromCC(obj: KubectlResponse): string {
  const conditions = obj.status?.conditions ?? [];
  const ready = conditions.find((c) => c.type === "Ready");
  if (ready) {
    if (ready.status === "True") return "READY";
    return ready.reason ?? "NOT_READY";
  }
  if (conditions.length > 0) {
    return conditions.map((c) => `${c.type}=${c.status}`).join(",");
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

  // Resolve the cluster identity for this environment before touching any
  // resource — a declared-but-mismatched binding throws here, aborting the
  // whole describe rather than letting the per-entity try/catch below
  // absorb it as an ordinary "not found".
  const { config } = await loadChantConfig(process.cwd());
  const target = await resolveClusterTarget(config as Record<string, unknown>, options.environment, "gcp");
  const ctxArg = target.context ? ["--context", target.context] : [];

  for (const [entityName, { entityType, props }] of options.entities) {
    const gvk = deriveGVK(entityType);
    if (!gvk) {
      // Not a `GCP::Service::Kind` this lexicon can turn into a Config
      // Connector GVK — nothing was queried, so nothing is known (#1089).
      unobserved[entityName] = {
        type: entityType,
        reason: "unsupported-kind",
        detail: `cannot derive a Config Connector GVK from ${entityType}`,
      };
      continue;
    }

    const metadata = props.metadata as { name?: string; namespace?: string } | undefined;
    const name = metadata?.name;
    if (!name) {
      unobserved[entityName] = {
        type: entityType,
        reason: "read-failed",
        detail: "declared entity has no metadata.name to query by",
      };
      continue;
    }

    const kubectlResource = `${gvk.kind.toLowerCase()}.${gvk.group}`;
    const nsArg = metadata.namespace ? ["-n", metadata.namespace] : [];
    const cmd = ["kubectl", "get", kubectlResource, name, ...nsArg, ...ctxArg, "-o", "json"].join(" ");

    try {
      const { stdout } = await execAsync(cmd);
      const obj: KubectlResponse = JSON.parse(stdout);
      // owned filter: withhold resources not carrying chant's marker label.
      // Withheld is not absent (#1089) — the CR exists, it just isn't chant's.
      if (options.owned && !hasOwnershipMarker(obj.metadata?.labels, LABEL_OWNERSHIP_KEYS)) {
        unobserved[entityName] = {
          type: entityType,
          reason: "filtered",
          detail: "live resource carries no chant ownership marker and --owned was requested",
        };
        continue;
      }
      result[entityName] = {
        type: entityType,
        physicalId: obj.metadata?.uid,
        status: statusFromCC(obj),
        lastUpdated: obj.metadata?.creationTimestamp,
        ownership: classifyOwnership(obj.metadata?.labels, LABEL_OWNERSHIP_KEYS),
        attributes: pruneUndefined({
          namespace: obj.metadata?.namespace,
          labels: obj.metadata?.labels,
          annotations: obj.metadata?.annotations,
        }),
      };
    } catch (err) {
      // A NotFound is a real absence (the CR isn't there, or Config Connector
      // doesn't serve that CRD, so no instance can be). Anything else — auth,
      // an unreachable API server, a context that doesn't resolve — proves
      // nothing and is reported as a hole rather than an absence (#1089).
      const outcome = classifyKubectlFailure(err);
      if (outcome.kind === "unobserved") {
        unobserved[entityName] = { type: entityType, reason: outcome.reason, detail: outcome.detail };
      }
    }
  }

  return observation(result, unobserved);
}
