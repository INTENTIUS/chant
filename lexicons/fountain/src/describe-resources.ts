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
 * (GET /api/environments|vaults|agents) and indexes it by name, the key
 * fountain reconciles by. The list promise is
 * cached per kind, so concurrent reads share one request and a failed list
 * marks only that kind's entities read-failed.
 *
 * Three kinds are read. The team-side kinds #2128 added went with Managoat's
 * removal of them (managoat/managoat#2793); a retired stub is reported as an
 * unsupported kind. The identity and ownership rules live in
 * ./live-identity.ts, shared with the deep reader so the two cannot disagree
 * about what a declaration matches.
 *
 * Endpoint + auth reuse the applier verbatim (FOUNTAIN_ENDPOINT /
 * FOUNTAIN_TOKEN), so plan reads the same instance fountainApply writes.
 * Secret *values* never appear anywhere on this path — the API is write-only
 * for values; the secrets sub-resource is not read here at all.
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
  OWNERSHIP_KEY,
  OWNERSHIP_VALUE,
  type FountainHttp,
} from "./op/activities/fountain-apply";
import {
  FountainLists,
  KIND_PATHS,
  effectiveName,
  ownershipOf,
  type LiveRecord,
  type Ownership,
} from "./live-identity";
import { AGENT_TYPE, ENVIRONMENT_TYPE, VAULT_TYPE } from "./deep-observe-hooks";

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

/**
 * The scrubbed outputs each kind reports, beyond its id and timestamps.
 *
 * These are what a snapshot diff compares.
 */
const ATTRIBUTE_FIELDS: Record<string, readonly string[]> = {
  [ENVIRONMENT_TYPE]: [],
  [VAULT_TYPE]: [],
  [AGENT_TYPE]: ["environment_id"],
};

function present(entityType: string, found: LiveRecord, ownership: Ownership): ResourceMetadata {
  const id = typeof found.id === "string" ? found.id : undefined;
  const attributes: Record<string, unknown> = {
    ...(id ? { id } : {}),
    ...(found.inserted_at ? { inserted_at: found.inserted_at } : {}),
    ...(found.updated_at ? { updated_at: found.updated_at } : {}),
  };
  for (const field of ATTRIBUTE_FIELDS[entityType] ?? []) {
    const value = found[field];
    if (value !== undefined && value !== null) attributes[field] = value;
  }

  return {
    type: entityType,
    ...(id ? { physicalId: id } : {}),
    status: "PRESENT",
    ...(typeof found.updated_at === "string" ? { lastUpdated: found.updated_at } : {}),
    attributes,
    ownership,
  };
}

function createAdapter(
  options: DescribeResourcesOptions,
  http?: FountainHttp,
): ObserverAdapter<FountainLists> {
  return {
    async bind() {
      if (http) return new FountainLists(http);

      const token = process.env.FOUNTAIN_TOKEN;
      if (!token) {
        throw new MissingTokenError(
          "FOUNTAIN_TOKEN is not set — cannot read live fountain state",
        );
      }
      return new FountainLists(
        defaultFountainHttp(resolveEndpoint({ endpoint: options.endpoint }), token),
      );
    },

    classifyBindFailure(err) {
      // The only whole-lexicon failure fountain has: nothing to authenticate
      // with. Anything else is a genuine fault and must stay loud.
      if (err instanceof MissingTokenError) {
        return { reason: "no-credentials", detail: err.message };
      }
      return "rethrow";
    },

    async read(lists, entity): Promise<EntityObservation> {
      if (!(entity.type in KIND_PATHS)) {
        return {
          unobserved: {
            reason: "unsupported-kind",
            detail: `no fountain read path for ${entity.type}`,
          },
        };
      }

      const key = effectiveName(entity.name, entity.props);

      // A list failure throws — the harness records read-failed for this
      // entity, and the cached rejected promise gives the same verdict to
      // every other entity of the kind without a second request.
      const live = await lists.byKey(entity.type);
      const found = live.get(key);

      // Observed absent: we asked, fountain said no → eligible for `create`.
      if (!found) return { absent: true };

      const ownership = ownershipOf(found);
      if (options.owned && ownership !== "owned") {
        return {
          unobserved: {
            reason: "filtered",
            detail: `"${key}" exists but does not carry the ${OWNERSHIP_KEY}: ${OWNERSHIP_VALUE} marker`,
          },
        };
      }

      return { present: present(entity.type, found, ownership) };
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
