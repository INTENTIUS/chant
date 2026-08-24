/**
 * GCP thin observation (#1209) — presence and scrubbed outputs, read over the
 * applier's own REST transport.
 *
 * chant applies GCP cluster-free over direct REST (#706). Until this, it
 * observed through a Config Connector cluster — `kubectl get <cnrm-gvk> -o
 * json` per entity — which is the split #1085's principle forbids: a lexicon
 * observed on a different transport than it is applied with can disagree with
 * itself about what a resource even is, and needs a GKE cluster to answer a
 * question about a bucket.
 *
 * Every GET here is built by the same `ResourceMapper` the applier uses (see
 * ./api/read-client.ts), so reader and applier cannot diverge about where a
 * resource lives.
 *
 * ## What changed in the answers, not just the transport
 *
 * **Status.** Config Connector encodes state as a `Ready` condition, which a
 * GCP REST payload has no equivalent of — a bucket simply exists. So a
 * successful GET is `PRESENT` unless the body carries a recognisable state of
 * its own (Cloud Run's `status.conditions`, an explicit `state`). `PRESENT` is
 * the same sentinel the Azure reader emits for the same reason.
 *
 * **Ownership.** CNRM carried chant's marker as a k8s label. The REST payloads
 * carry `labels` only on kinds that have them (a bucket does; a Pub/Sub topic
 * does not), so ownership is `unknown` where there is nothing to read — and
 * `--owned` degrades to detect-only rather than withholding everything it
 * cannot prove, the same posture the AWS thin path takes when
 * `describe-stack-resources` returns no tags.
 *
 * **Coverage.** kubectl could fetch any CNRM kind the cluster knew about; REST
 * reaches the kinds the applier has a mapper for. That is narrower on paper and
 * not in practice: a kind with no mapper cannot be applied either, so observing
 * it produced a live tree nothing could reconcile against. Anything outside the
 * table reports NOT-OBSERVED with `unsupported-kind` (#1089) rather than being
 * dropped.
 */

import type { ObservationResult, ResourceMetadata, UnobservedEntity } from "@intentius/chant/lexicon";
import { observation } from "@intentius/chant/observation";
import { hasOwnershipMarker, classifyOwnership, readOwnership, type ChannelKeys } from "@intentius/chant/ownership";
import { getResource, mapperForKind, GcpReadError, isNotFound, type GcpReadClientOptions } from "./api/read-client";
import { resolveGcpProject, parseManifest } from "./op/activities/gcp-apply";
import { resolveGVK } from "./serializer";

/**
 * chant's ownership marker as GCP labels.
 *
 * The applier stamps `managed-by: chant` (gcp-apply.ts) because GCP label keys
 * cannot hold the k8s `app.kubernetes.io/managed-by` slash/dot form that
 * `LABEL_OWNERSHIP_KEYS` uses — so the reader has to look for what the applier
 * actually wrote, not for the CNRM label the kubectl path read. The stack/env
 * keys follow the same flattening.
 */
const GCP_OWNERSHIP_LABEL_KEYS: ChannelKeys = {
  managedBy: "managed-by",
  stack: "chant-stack",
  env: "chant-env",
};

/** The parts of a GCP REST payload this reader looks at. Every field is
 * optional because they vary by kind — a bucket has `id` and `labels`, a
 * Pub/Sub topic has neither. */
interface GcpRestResponse {
  id?: string;
  name?: string;
  selfLink?: string;
  labels?: Record<string, string> | null;
  updated?: string;
  timeCreated?: string;
  state?: string;
  status?: {
    conditions?: Array<{ type?: string; status?: string; state?: string; reason?: string }>;
    [k: string]: unknown;
  };
}

/**
 * The CNRM group/kind for an entity type, resolved through the serializer's
 * own GVK map so the reader and the manifest agree on the kind's casing —
 * `GCP::Pubsub::Topic` is `PubSubTopic` in CNRM and in the applier's mapper
 * table, while a naive `${service}${shortKind}` concatenation would produce
 * `PubsubTopic` and silently miss the mapper for 4 of the 6 appliable kinds.
 */
export function deriveGVK(entityType: string): { group: string; kind: string } | null {
  const resolved = resolveGVK(entityType);
  if (!resolved) return null;
  return { group: resolved.apiVersion.split("/")[0], kind: resolved.kind };
}

/**
 * The `cnrm.cloud.google.com/project-id` annotations in the built manifest,
 * keyed `kind/name`.
 *
 * The declared entities the observe paths receive are discovery output, and a
 * project-wide `defaultAnnotations({"cnrm.cloud.google.com/project-id": …})`
 * is a separate declarable the serializer merges into each document at
 * synthesis — the entity's own props never see it. The applier resolves its
 * project from the manifest for exactly that reason, so the readers do too:
 * without this, every entity relying on the default annotation reports
 * `no-binding` unless the shell happens to export GOOGLE_CLOUD_PROJECT.
 */
export function manifestProjectAnnotations(buildOutput: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!buildOutput) return out;
  try {
    for (const doc of parseManifest(buildOutput, "<build output>")) {
      const project = doc.metadata?.annotations?.["cnrm.cloud.google.com/project-id"];
      if (doc.kind && doc.metadata?.name && typeof project === "string") {
        out.set(`${doc.kind}/${doc.metadata.name}`, project);
      }
    }
  } catch {
    // An unparsable build output resolves nothing — per-entity annotations and
    // GOOGLE_CLOUD_PROJECT still apply, and a truly unresolvable project is
    // still reported as `no-binding` per entity.
  }
  return out;
}

/**
 * The project a read should target: `GOOGLE_CLOUD_PROJECT` / the entity's own
 * annotation (via `resolveGcpProject`, the applier's rule), then the built
 * manifest's merged annotation. Throws the applier's own error when nothing
 * resolves, so the `no-binding` detail names both knobs.
 */
export function resolveReadProject(
  kind: string,
  name: string,
  metadata: { annotations?: Record<string, string> } | undefined,
  manifestProjects: Map<string, string>,
): string {
  try {
    return resolveGcpProject({ kind, metadata });
  } catch (err) {
    const fromManifest = manifestProjects.get(`${kind}/${name}`);
    if (fromManifest) return fromManifest;
    throw err;
  }
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Status from a REST payload.
 *
 * Most GCP resources have no status at all — a bucket that answers a GET simply
 * exists — so `PRESENT` is the honest answer and the common one. Where a kind
 * does carry state (Cloud Run's `status.conditions`, a `state` enum), that is
 * reported instead.
 *
 * `PRESENT` is deliberately the same sentinel the Azure reader emits for a
 * resource with no `provisioningState`: one word, meaning "read it back, it is
 * there, there is nothing richer to say".
 */
export function statusFromRest(obj: GcpRestResponse): string {
  if (typeof obj.state === "string" && obj.state.length > 0) return obj.state;
  const conditions = obj.status?.conditions ?? [];
  const ready = conditions.find((c) => c.type === "Ready");
  if (ready) {
    if (ready.status === "True" || ready.state === "CONDITION_SUCCEEDED") return "READY";
    return ready.reason ?? "NOT_READY";
  }
  if (conditions.length > 0) {
    return conditions.map((c) => `${c.type}=${c.status ?? c.state}`).join(",");
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

  // The endpoint override is the emulator tell (floci-gcp :4588); unset means
  // real GCP, exactly as it does for the applier.
  const endpoint = process.env.GCP_ENDPOINT_URL;

  // `--owned` needs labels to filter on, and only some kinds carry them. Rather
  // than withhold everything it cannot prove, this warns once and degrades to
  // detect-only — the same posture the AWS thin path takes when
  // `describe-stack-resources` returns no tags.
  let warnedOwnership = false;

  const manifestProjects = manifestProjectAnnotations(options.buildOutput);

  const reads = [...options.entities].map(async ([entityName, { entityType, props }]) => {
    const gvk = deriveGVK(entityType);
    if (!gvk) {
      unobserved[entityName] = {
        type: entityType,
        reason: "unsupported-kind",
        detail: `cannot derive a GCP kind from ${entityType}`,
      };
      return;
    }
    if (!mapperForKind(gvk.kind)) {
      // Outside the applier's dispatch table: chant cannot write this kind, so
      // it does not claim to have read it either (#1089).
      unobserved[entityName] = {
        type: entityType,
        reason: "unsupported-kind",
        detail: `no REST mapper for ${gvk.kind} — chant cannot apply this kind either`,
      };
      return;
    }

    const metadata = props.metadata as { name?: string; annotations?: Record<string, string> } | undefined;
    const name = metadata?.name;
    if (!name) {
      unobserved[entityName] = {
        type: entityType,
        reason: "read-failed",
        detail: "declared entity has no metadata.name to query by",
      };
      return;
    }

    let client: GcpReadClientOptions;
    try {
      client = {
        project: resolveReadProject(gvk.kind, name, metadata, manifestProjects),
        ...(endpoint ? { endpoint } : {}),
      };
    } catch (err) {
      // No project resolvable — nothing was queried, so nothing is known.
      unobserved[entityName] = {
        type: entityType,
        reason: "no-binding",
        detail: err instanceof Error ? err.message : String(err),
      };
      return;
    }

    try {
      const obj = (await getResource(client, gvk.kind, name, props)) as GcpRestResponse;

      if (options.owned) {
        if (obj.labels == null) {
          if (!warnedOwnership) {
            // eslint-disable-next-line no-console
            console.warn(
              `[gcp] ownership filter unavailable for ${gvk.kind} (the REST payload carries no labels) — returning it with an \`unknown\` verdict rather than withholding it`,
            );
            warnedOwnership = true;
          }
        } else if (!hasOwnershipMarker(obj.labels, GCP_OWNERSHIP_LABEL_KEYS)) {
          // Withheld is not absent (#1089) — the resource exists, it just isn't chant's.
          unobserved[entityName] = {
            type: entityType,
            reason: "filtered",
            detail: "live resource carries no chant ownership marker and --owned was requested",
          };
          return;
        }
      }

      result[entityName] = {
        type: entityType,
        physicalId: obj.id ?? obj.selfLink ?? obj.name,
        status: statusFromRest(obj),
        lastUpdated: obj.updated ?? obj.timeCreated,
        ownership: obj.labels == null ? "unknown" : classifyOwnership(obj.labels, GCP_OWNERSHIP_LABEL_KEYS),
        // Marker identity (#1222): stack/env from the resource's own labels.
        // Undefined when the payload carries no labels or no managed-by marker.
        marker: readOwnership(obj.labels ?? undefined, GCP_OWNERSHIP_LABEL_KEYS),
        attributes: pruneUndefined({
          labels: obj.labels ?? undefined,
          selfLink: obj.selfLink,
        }),
      };
    } catch (err) {
      // A 404 is a real absence. Anything else — no credentials, an
      // unreachable endpoint, a body that will not parse — proves nothing and
      // is a hole rather than an absence (#1089).
      if (isNotFound(err)) return;
      const status = err instanceof GcpReadError ? err.status : undefined;
      const noCreds = status === 401 || status === 403;
      unobserved[entityName] = {
        type: entityType,
        reason: noCreds ? "no-credentials" : "read-failed",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // Concurrent, where the kubectl path was one spawn after another (#1201/#1209).
  await Promise.all(reads);

  return observation(result, unobserved);
}
