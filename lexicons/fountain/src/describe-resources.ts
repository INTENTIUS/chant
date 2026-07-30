/**
 * Live introspection of fountain resources — the read-back seam for chant's
 * plan/drift machinery.
 *
 * Drives core's observer harness (`observeEntities`, #1201) rather than
 * re-deriving its control flow: bind-or-not-observe-all with a typed reason,
 * per-entity tri-state routing, and a read throw degrading to `read-failed`
 * rather than a silent absence that would classify as a spurious `create`.
 * What this lexicon supplies is the adapter — the transport and the per-entity
 * read.
 *
 * The read is a lookup, not a fetch: fountain has no per-resource-by-name
 * endpoint, so the adapter lists each declared kind once
 * (GET /api/environments|vaults|agents) and indexes it by name. The list
 * promise is cached per kind, so concurrent reads share one request and a
 * failed list marks only that kind's entities read-failed.
 *
 * Ownership comes from the `managed-by: chant` metadata marker (fountain#137
 * gave all three kinds the channel). Endpoint + auth reuse the applier
 * verbatim (FOUNTAIN_ENDPOINT / FOUNTAIN_TOKEN), so plan reads the same
 * instance fountainApply writes. Secret *values* never appear anywhere on
 * this path — the API is write-only for values; the secrets sub-resource is
 * not read here at all.
 */

import type { ObservationResult, ResourceMetadata } from "@intentius/chant/lexicon";
import {
  observeEntities,
  type DeclaredEntity,
  type EntityObservation,
  type ObserverAdapter,
} from "@intentius/chant/observation";
import {
  resolveEndpoint,
  defaultFountainHttp,
  isChantOwned,
  OWNERSHIP_KEY,
  OWNERSHIP_VALUE,
  type FountainHttp,
} from "./op/activities/fountain-apply";

const KIND_PATHS: Record<string, string> = {
  "Fountain::V1::Environment": "environments",
  "Fountain::V1::Vault": "vaults",
  "Fountain::V1::Agent": "agents",
};

/** Thrown by bind() when there is no token to read with. */
class MissingTokenError extends Error {}

export interface DescribeResourcesOptions {
  environment: string;
  buildOutput: string;
  entityNames: string[];
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
  /** Restrict to chant-owned resources. */
  owned?: boolean;
  /** Endpoint override (tests). Defaults to resolveEndpoint(). */
  endpoint?: string;
}

interface LiveResource {
  id: string;
  name: string;
  metadata?: Record<string, unknown>;
  inserted_at?: string;
  updated_at?: string;
  /** Agents only — the reference edge the catalog reconstructs. */
  environment_id?: string | null;
}

/** The transport plus its per-kind list cache. */
interface FountainClient {
  http: FountainHttp;
  /** entityType → in-flight or settled list, indexed by resource name. */
  lists: Map<string, Promise<Map<string, LiveResource>>>;
}

function listKind(client: FountainClient, entityType: string): Promise<Map<string, LiveResource>> {
  const cached = client.lists.get(entityType);
  if (cached) return cached;

  const path = KIND_PATHS[entityType];
  const pending = (async () => {
    const { status, json } = await client.http("GET", `/api/${path}`);
    if (status !== 200) throw new Error(`list ${path} returned ${status}`);
    const data = (json as { data?: LiveResource[] })?.data ?? [];
    return new Map(data.map((r) => [r.name, r]));
  })();

  client.lists.set(entityType, pending);
  return pending;
}

function present(entityType: string, found: LiveResource, owned: boolean): ResourceMetadata {
  return {
    type: entityType,
    physicalId: found.id,
    status: "PRESENT",
    ...(found.updated_at ? { lastUpdated: found.updated_at } : {}),
    attributes: {
      id: found.id,
      ...(found.inserted_at ? { inserted_at: found.inserted_at } : {}),
      ...(found.updated_at ? { updated_at: found.updated_at } : {}),
      ...(found.environment_id ? { environment_id: found.environment_id } : {}),
    },
    ownership: owned ? "owned" : "foreign",
  };
}

function createAdapter(
  options: DescribeResourcesOptions,
  http?: FountainHttp,
): ObserverAdapter<FountainClient> {
  return {
    async bind() {
      if (http) return { http, lists: new Map() };

      const token = process.env.FOUNTAIN_TOKEN;
      if (!token) {
        throw new MissingTokenError(
          "FOUNTAIN_TOKEN is not set — cannot read live fountain state",
        );
      }
      return {
        http: defaultFountainHttp(resolveEndpoint({ endpoint: options.endpoint }), token),
        lists: new Map(),
      };
    },

    classifyBindFailure(err) {
      // The only whole-lexicon failure fountain has: nothing to authenticate
      // with. Anything else is a genuine fault and must stay loud.
      if (err instanceof MissingTokenError) {
        return { reason: "no-credentials", detail: err.message };
      }
      return "rethrow";
    },

    async read(client, entity): Promise<EntityObservation> {
      if (!(entity.type in KIND_PATHS)) {
        return {
          unobserved: {
            reason: "unsupported-kind",
            detail: `no fountain read path for ${entity.type}`,
          },
        };
      }

      // A list failure throws — the harness records read-failed for this
      // entity, and the cached rejected promise gives the same verdict to
      // every other entity of the kind without a second request.
      const live = await listKind(client, entity.type);

      const resourceName =
        typeof entity.props.name === "string" ? (entity.props.name as string) : entity.name;
      const found = live.get(resourceName);

      // Observed absent: we asked, fountain said no → eligible for `create`.
      if (!found) return { absent: true };

      const owned = isChantOwned(found);
      if (options.owned && !owned) {
        return {
          unobserved: {
            reason: "filtered",
            detail: `"${resourceName}" exists but does not carry the ${OWNERSHIP_KEY}: ${OWNERSHIP_VALUE} marker`,
          },
        };
      }

      return { present: present(entity.type, found, owned) };
    },
  };
}

/**
 * `http` is injectable for tests; the default reuses the applier's fetch
 * client (bearer token from FOUNTAIN_TOKEN).
 */
export async function describeResources(
  options: DescribeResourcesOptions,
  http?: FountainHttp,
): Promise<ObservationResult> {
  const declared: DeclaredEntity[] = [...options.entities].map(([name, entity]) => ({
    name,
    type: entity.entityType,
    props: entity.props,
  }));

  return observeEntities(declared, createAdapter(options, http));
}
