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
 * (GET /api/environments|vaults|agents|team|team/schedules|webhooks) and
 * indexes it by the key that kind is reconciled under. The list promise is
 * cached per kind, so concurrent reads share one request and a failed list
 * marks only that kind's entities read-failed.
 *
 * Six kinds are read (#2128). The three team-side ones do not key on a name
 * the way the first three do — a schedule is identified by its teammate and
 * its name together, a webhook by its url — and they carry no `managed-by`
 * marker of their own, so ownership is inherited from the agent behind them
 * and a webhook's verdict is `unknown`. Both rules live in ./live-identity.ts,
 * shared with the deep reader so the two cannot disagree about what a
 * declaration matches.
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
  declaredKey,
  nameIndex,
  ownershipGap,
  ownershipOf,
  type LiveRecord,
  type Ownership,
} from "./live-identity";
import {
  AGENT_TYPE,
  ENVIRONMENT_TYPE,
  SCHEDULE_TYPE,
  TEAMMATE_TYPE,
  VAULT_TYPE,
  WEBHOOK_TYPE,
} from "./deep-observe-hooks";

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
 * These are what a snapshot diff compares, and therefore what
 * `classifyDisruption` (./disruption.ts) is handed as `attributes.<key>`
 * deltas — a teammate's `vault_id` moving is only classifiable as `replace`
 * because the id is here. Deliberately excluded: a schedule's `next_run_at`,
 * `last_run_at`, `last_error` and `last_conversation_id`, which the scheduler
 * rewrites on every fire and which would report a working schedule as drift on
 * every read.
 */
const ATTRIBUTE_FIELDS: Record<string, readonly string[]> = {
  [ENVIRONMENT_TYPE]: [],
  [VAULT_TYPE]: [],
  [AGENT_TYPE]: ["environment_id"],
  [TEAMMATE_TYPE]: ["agent_id", "environment_id", "vault_id"],
  [SCHEDULE_TYPE]: ["agent_id", "cron", "prompt", "enabled", "one_off"],
  [WEBHOOK_TYPE]: ["url", "status", "event_types"],
};

/**
 * A teammate has no id column of its own — it *is* an agent on the reserved
 * team channel — so the agent's id is its physical identity.
 */
function physicalIdOf(entityType: string, record: LiveRecord): string | undefined {
  if (entityType === TEAMMATE_TYPE) {
    return typeof record.agent_id === "string" ? record.agent_id : undefined;
  }
  return typeof record.id === "string" ? record.id : undefined;
}

/**
 * A teammate's environment and vault are per-launch settings on its
 * conversation, not columns on the roster row, so read them from there when
 * the row itself does not carry them.
 */
function attributeSource(entityType: string, record: LiveRecord): Record<string, unknown> {
  if (entityType !== TEAMMATE_TYPE) return record;
  const conversation =
    record.conversation && typeof record.conversation === "object"
      ? (record.conversation as Record<string, unknown>)
      : {};
  return { ...conversation, ...record };
}

function present(entityType: string, found: LiveRecord, ownership: Ownership): ResourceMetadata {
  const id = physicalIdOf(entityType, found);
  const source = attributeSource(entityType, found);
  const attributes: Record<string, unknown> = {
    ...(id ? { id } : {}),
    ...(found.inserted_at ? { inserted_at: found.inserted_at } : {}),
    ...(found.updated_at ? { updated_at: found.updated_at } : {}),
  };
  for (const field of ATTRIBUTE_FIELDS[entityType] ?? []) {
    const value = source[field];
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

/** Why an entity was withheld by `--owned`, in terms of the channel that kind actually has. */
function filteredDetail(entityType: string, key: string, ownership: Ownership): string {
  if (ownership === "unknown") {
    return `"${key}" exists but its ownership cannot be established — ${ownershipGap(entityType)}`;
  }
  return `"${key}" exists but does not carry the ${OWNERSHIP_KEY}: ${OWNERSHIP_VALUE} marker`;
}

function createAdapter(
  options: DescribeResourcesOptions,
  http?: FountainHttp,
): ObserverAdapter<FountainLists> {
  const index = nameIndex(options.entities);

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

      const key = declaredKey(entity.type, entity.name, entity.props, index);
      if (key === undefined) {
        // Not an absence: the declaration itself resolves to no identity, so
        // the read never happened. FTN021 is the build-time version of this.
        return {
          unobserved: {
            reason: "read-failed",
            detail: `"${entity.name}" does not resolve to a fountain identity — a schedule needs a teammate reference, a webhook a url`,
          },
        };
      }

      // A list failure throws — the harness records read-failed for this
      // entity, and the cached rejected promise gives the same verdict to
      // every other entity of the kind without a second request.
      const live = await lists.byKey(entity.type);
      const found = live.get(key);

      // Observed absent: we asked, fountain said no → eligible for `create`.
      if (!found) return { absent: true };

      const ownership = ownershipOf(entity.type, found, await lists.rosterFor(entity.type));
      if (options.owned && ownership !== "owned") {
        return {
          unobserved: {
            reason: "filtered",
            detail: filteredDetail(entity.type, key, ownership),
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
