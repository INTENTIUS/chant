/**
 * Live introspection of a Kubernetes cluster — implements the
 * LexiconPlugin.describeResources() contract for the k8s lexicon.
 *
 * ## What changed, and why it matters (chant #1074)
 *
 * This used to run `kubectl get <kind> <name> -o json` once per declared
 * entity, serially, resolved through a hardcoded twenty-entry
 * `KUBECTL_RESOURCE` map. Every CRD and every uncommon type fell off the end
 * of that map and came back as a hole. Coverage, concurrency and error quality
 * were all capped by it, and `lifecycle diff --live`, `lifecycle plan` and
 * behold's overlay inherited the cap.
 *
 * Now:
 *
 * - **Coverage.** An entity type becomes an API address through the generated
 *   operation surface (`./api/operation-surface.ts`), which the same codegen
 *   pass that emits the declarable classes writes — 184 types rather than 20,
 *   CRDs included. The address is then confirmed against the cluster's *own*
 *   discovery, which is what knows the plural and the scope for the version
 *   that cluster actually serves.
 * - **Concurrency.** Reads run through the client's bounded pool. A hundred
 *   entities are a hundred concurrent HTTP GETs sharing one connection and one
 *   cached credential, not a hundred serial process spawns.
 * - **Error quality.** Failures arrive as typed errors carrying the API
 *   server's own `code` and `reason`, so the tri-state verdict is read off a
 *   field instead of matched against English on stderr.
 *
 * ## What did not change
 *
 * The observation tri-state (chant #1089) and the cluster binding (chant
 * #1100/#1155) are the same contracts they were. A genuine `NotFound` — and a
 * kind the cluster's discovery does not serve, where no instance can exist —
 * is an absence, and only an absence becomes a `create`. Everything else is
 * NOT-OBSERVED with a reason. A declared `k8s.profiles.<env>.context` that
 * disagrees with the ambient one still refuses before a single resource is
 * touched, via the same `resolveClusterTarget` the GCP lexicon shares.
 *
 * ## Runtime children (chant #1077)
 *
 * A Pod a declared Deployment's controller created is live and undeclared —
 * exactly the shape `lifecycle diff --live` has always classified `orphan`.
 * On Kubernetes that is wrong: it is expected runtime, not drift, and will be
 * recreated the moment it is deleted. After the declared-entity reads above
 * resolve, this scans Pods in the namespaces they actually live in and walks
 * each one's `ownerReferences` chain (`./api/owner-chain.ts`) against the
 * entities this very call resolved. A chain reaching one of them is reported
 * with `ownerChain: { root: "declared", ... }`; core's diff/change-set engine
 * reads that as `runtime` instead of `orphan`. Deliberately scoped to Pods —
 * the concrete case the issue and its acceptance criteria name — and to the
 * namespaces this observation already touched, not a cluster-wide sweep;
 * widening to other controller-spawned kinds is the same walk repeated.
 */

import type { ObservationResult, ResourceMetadata, UnobservedEntity } from "@intentius/chant/lexicon";
import { observation, unobservedAll } from "@intentius/chant/observation";
import { hasOwnershipMarker, classifyOwnership, LABEL_OWNERSHIP_KEYS } from "@intentius/chant/ownership";
import type { K8sClient, K8sObject } from "@intentius/chant-k8s-client";
import { defaultK8sConnector, type K8sConnector } from "./api/connect";
import {
  classifyApiFailure,
  isMissingClientPackage,
  isWholeLexiconFailure,
  MISSING_CLIENT_DETAIL,
} from "./api/classify";
import { operationFor } from "./api/operation-surface";
import { resolveK8sOwnerChain } from "./api/owner-chain";

function pruneUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Collapse a live object to one status word. Unchanged from the kubectl path
 * — the shape of the response is the same JSON either way.
 */
export function statusFromObject(obj: K8sObject): string {
  const status = obj.status;
  const phase = status?.phase;
  if (typeof phase === "string") return phase;
  if (status && typeof status.readyReplicas === "number" && typeof status.replicas === "number") {
    return status.readyReplicas === status.replicas
      ? "READY"
      : `PROGRESSING(${status.readyReplicas}/${status.replicas})`;
  }
  return "PRESENT";
}

interface Declared {
  entityName: string;
  entityType: string;
  props: Record<string, unknown>;
}

export interface DescribeResourcesOptions {
  environment: string;
  buildOutput: string;
  entityNames: string[];
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
  owned?: boolean;
  /** Directory whose `chant.config.ts` carries the cluster binding. Defaults to cwd. */
  cwd?: string;
}

export async function describeResources(
  options: DescribeResourcesOptions,
  connect: K8sConnector = defaultK8sConnector,
): Promise<ObservationResult> {
  const resources: Record<string, ResourceMetadata> = {};
  const unobserved: Record<string, UnobservedEntity> = {};

  const declared: Declared[] = [...options.entities].map(([entityName, entity]) => ({
    entityName,
    entityType: entity.entityType,
    props: entity.props,
  }));

  // Connect first. The binding check lives here, so a bound-but-mismatched
  // context throws before any resource is read — core turns that into
  // NOT-OBSERVED for every declared entity rather than an empty result.
  let client;
  try {
    ({ client } = await connect({ environment: options.environment, cwd: options.cwd }));
  } catch (err) {
    if (isMissingClientPackage(err)) {
      return observation(
        {},
        unobservedAll(
          declared.map((d) => d.entityName),
          "read-failed",
          MISSING_CLIENT_DETAIL,
          options.entities,
        ),
      );
    }
    if (isWholeLexiconFailure(err)) {
      const outcome = classifyApiFailure(err);
      return observation(
        {},
        unobservedAll(
          declared.map((d) => d.entityName),
          outcome.kind === "unobserved" ? outcome.reason : "read-failed",
          outcome.kind === "unobserved" ? outcome.detail : undefined,
          options.entities,
        ),
      );
    }
    // A cluster-binding mismatch (chant #1100) belongs here: it is a loud
    // refusal, and core's whole-lexicon handling is what turns it into an
    // honest hole per entity.
    throw err;
  }

  await client.concurrently(declared, async ({ entityName, entityType, props }) => {
    const operation = operationFor(entityType);
    if (!operation) {
      // chant knows no API address for this type at all — not even its group.
      // The object may well exist, so this is a hole, never an absence.
      unobserved[entityName] = {
        type: entityType,
        reason: "unsupported-kind",
        detail: `no generated operation surface for ${entityType} — run \`chant generate\` in the k8s lexicon, or declare the CRD as a codegen source`,
      };
      return;
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
      return;
    }

    try {
      const obj = await client.read({
        apiVersion: operation.apiVersion,
        kind: operation.kind,
        name,
        ...(metadata?.namespace ? { namespace: metadata.namespace } : {}),
      });

      // owned filter: withhold resources not carrying chant's marker label.
      // Withheld is not absent (chant #1089) — this object exists, it just
      // isn't chant's, and dropping it silently is how `--owned` used to turn a
      // declared-but-foreign resource into a proposed `create`.
      if (options.owned && !hasOwnershipMarker(obj.metadata?.labels, LABEL_OWNERSHIP_KEYS)) {
        unobserved[entityName] = {
          type: entityType,
          reason: "filtered",
          detail: "live object carries no chant ownership marker and --owned was requested",
        };
        return;
      }

      resources[entityName] = {
        type: entityType,
        physicalId: obj.metadata?.uid,
        status: statusFromObject(obj),
        lastUpdated: obj.metadata?.creationTimestamp,
        ownership: classifyOwnership(obj.metadata?.labels, LABEL_OWNERSHIP_KEYS),
        attributes: pruneUndefined({
          namespace: obj.metadata?.namespace,
          labels: obj.metadata?.labels,
          resourceVersion: obj.metadata?.resourceVersion,
        }),
      };
    } catch (err) {
      const outcome = classifyApiFailure(err);
      if (outcome.kind === "unobserved") {
        unobserved[entityName] = { type: entityType, reason: outcome.reason, detail: outcome.detail };
      }
      // `absent` deliberately records nothing: in neither map is how the
      // contract spells "asked, and it is not there".
    }
  });

  await addRuntimeChildren(client, resources, options.owned);

  return observation(resources, unobserved);
}

/**
 * Scan Pods in the namespaces of entities this call just resolved, and
 * classify each one's owner-reference chain (#1077). Mutates `resources` in
 * place, adding an entry per Pod whose chain was worth reporting.
 *
 * Best-effort and additive: a namespace this scan cannot list (RBAC denial,
 * a transient error) is simply skipped rather than failing the observation —
 * Pods are not declared entities, so there is no NOT-OBSERVED axis for them
 * to report against, the same way an out-of-band AWS child resource has none
 * either.
 */
async function addRuntimeChildren(
  client: K8sClient,
  resources: Record<string, ResourceMetadata>,
  owned: boolean | undefined,
): Promise<void> {
  const declaredByUid = new Map<string, string>();
  for (const [entityName, meta] of Object.entries(resources)) {
    if (meta.physicalId) declaredByUid.set(meta.physicalId, entityName);
  }

  const namespaces = new Set<string>();
  for (const meta of Object.values(resources)) {
    const namespace = (meta.attributes as { namespace?: string } | undefined)?.namespace;
    if (namespace) namespaces.add(namespace);
  }
  if (namespaces.size === 0) return;

  await client.concurrently([...namespaces], async (namespace) => {
    let pods: K8sObject[];
    try {
      pods = await client.list({ apiVersion: "v1", kind: "Pod" }, { namespace });
    } catch {
      return; // best-effort — see the function doc
    }

    await client.concurrently(pods, async (pod) => {
      const uid = pod.metadata?.uid;
      const name = pod.metadata?.name;
      if (!uid || !name || declaredByUid.has(uid)) return; // declared directly, or unaddressable

      const ownerChain = await resolveK8sOwnerChain(pod, { declaredByUid, reader: client, namespace });

      // `--owned`: withhold a Pod that is neither a runtime child of a
      // declared entity nor carrying chant's own marker — the same rule the
      // declared-entity read above applies, extended to the undeclared axis
      // this scan introduces.
      const marker = hasOwnershipMarker(pod.metadata?.labels, LABEL_OWNERSHIP_KEYS);
      if (owned && ownerChain.root !== "declared" && !marker) return;

      resources[`${namespace}/${name}`] = {
        type: "K8s::Core::Pod",
        physicalId: uid,
        status: statusFromObject(pod),
        lastUpdated: pod.metadata?.creationTimestamp,
        ownership: classifyOwnership(pod.metadata?.labels, LABEL_OWNERSHIP_KEYS),
        ownerChain,
        attributes: pruneUndefined({
          namespace,
          labels: pod.metadata?.labels,
          resourceVersion: pod.metadata?.resourceVersion,
        }),
      };
    });
  });
}
