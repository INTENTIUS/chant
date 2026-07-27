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
 * Resource-not-found is silent — `state diff --live` reports it as missing.
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
import type { ResourceMetadata } from "@intentius/chant/lexicon";
import { hasOwnershipMarker, classifyOwnership, LABEL_OWNERSHIP_KEYS } from "@intentius/chant/ownership";
import { loadChantConfig } from "@intentius/chant/config";
import { resolveClusterTarget } from "@intentius/chant/kubectl-context";

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
}): Promise<Record<string, ResourceMetadata>> {
  const result: Record<string, ResourceMetadata> = {};

  // Resolve the cluster identity for this environment before touching any
  // resource — a declared-but-mismatched binding throws here, aborting the
  // whole describe rather than letting the per-entity try/catch below
  // absorb it as an ordinary "not found".
  const { config } = await loadChantConfig(process.cwd());
  const target = await resolveClusterTarget(config as Record<string, unknown>, options.environment, "gcp");
  const ctxArg = target.context ? ["--context", target.context] : [];

  for (const [entityName, { entityType, props }] of options.entities) {
    const gvk = deriveGVK(entityType);
    if (!gvk) continue;

    const metadata = props.metadata as { name?: string; namespace?: string } | undefined;
    const name = metadata?.name;
    if (!name) continue;

    const kubectlResource = `${gvk.kind.toLowerCase()}.${gvk.group}`;
    const nsArg = metadata.namespace ? ["-n", metadata.namespace] : [];
    const cmd = ["kubectl", "get", kubectlResource, name, ...nsArg, ...ctxArg, "-o", "json"].join(" ");

    try {
      const { stdout } = await execAsync(cmd);
      const obj: KubectlResponse = JSON.parse(stdout);
      // owned filter: skip resources not carrying chant's marker label.
      if (options.owned && !hasOwnershipMarker(obj.metadata?.labels, LABEL_OWNERSHIP_KEYS)) {
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
    } catch {
      // CRD or instance not found — skip silently
    }
  }

  return result;
}
