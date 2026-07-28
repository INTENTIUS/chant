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
 */

import type { ObservationResult, ResourceMetadata, UnobservedEntity } from "@intentius/chant/lexicon";
import { observation, unobservedAll } from "@intentius/chant/observation";
import { hasOwnershipMarker, classifyOwnership, LABEL_OWNERSHIP_KEYS } from "@intentius/chant/ownership";
import type { K8sObject } from "@intentius/chant-k8s-client";
import { defaultK8sConnector, type K8sConnector } from "./api/connect";
import {
  classifyApiFailure,
  isMissingClientPackage,
  isWholeLexiconFailure,
  MISSING_CLIENT_DETAIL,
} from "./api/classify";
import { operationFor } from "./api/operation-surface";

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

  return observation(resources, unobserved);
}
