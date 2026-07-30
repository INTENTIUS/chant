/**
 * Live introspection of fountain resources — the read-back seam for chant's
 * plan/drift machinery.
 *
 * Lists each declared kind once (GET /api/environments|vaults|agents), keys
 * live resources by name, and reports the standard tri-state: observed
 * present (with an ownership verdict from the `managed-by: chant` metadata
 * marker — fountain#137 gave all three kinds the channel), observed absent
 * (asked, not there → a `create` in the plan), or unobserved with a total
 * reason (no token, read failed, unsupported kind — never a phantom create).
 *
 * Endpoint + auth reuse the applier verbatim (FOUNTAIN_ENDPOINT /
 * FOUNTAIN_TOKEN), so plan reads the same instance fountainApply writes.
 * Secret *values* never appear anywhere on this path — the API is write-only
 * for values; the secrets sub-resource is not read here at all.
 */

import type { ObservationResult, ResourceMetadata, UnobservedEntity } from "@intentius/chant/lexicon";
import { observation, unobservedAll } from "@intentius/chant/observation";
import {
  resolveEndpoint,
  defaultFountainHttp,
  isChantOwned,
  type FountainHttp,
} from "./op/activities/fountain-apply";

const KIND_PATHS: Record<string, string> = {
  "Fountain::V1::Environment": "environments",
  "Fountain::V1::Vault": "vaults",
  "Fountain::V1::Agent": "agents",
};

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

/**
 * `http` is injectable for tests; the default reuses the applier's fetch
 * client (bearer token from FOUNTAIN_TOKEN).
 */
export async function describeResources(
  options: DescribeResourcesOptions,
  http?: FountainHttp,
): Promise<ObservationResult> {
  const resources: Record<string, ResourceMetadata> = {};
  const unobserved: Record<string, UnobservedEntity> = {};

  let client = http;
  if (!client) {
    const token = process.env.FOUNTAIN_TOKEN;
    if (!token) {
      return observation(
        resources,
        unobservedAll(
          options.entities.keys(),
          "no-credentials",
          "FOUNTAIN_TOKEN is not set — cannot read live fountain state",
          options.entities,
        ),
      );
    }
    client = defaultFountainHttp(resolveEndpoint({ endpoint: options.endpoint }), token);
  }

  // One list per declared kind, cached; a failed list marks that kind's
  // entities read-failed without blocking the other kinds.
  const liveByKind = new Map<string, Map<string, LiveResource> | Error>();
  const listKind = async (entityType: string): Promise<Map<string, LiveResource> | Error> => {
    const cached = liveByKind.get(entityType);
    if (cached) return cached;
    let result: Map<string, LiveResource> | Error;
    try {
      const { status, json } = await client!("GET", `/api/${KIND_PATHS[entityType]}`);
      if (status !== 200) {
        result = new Error(`list ${KIND_PATHS[entityType]} returned ${status}`);
      } else {
        const data = (json as { data?: LiveResource[] })?.data ?? [];
        result = new Map(data.map((r) => [r.name, r]));
      }
    } catch (err) {
      result = err instanceof Error ? err : new Error(String(err));
    }
    liveByKind.set(entityType, result);
    return result;
  };

  for (const [entityName, entity] of options.entities) {
    if (!(entity.entityType in KIND_PATHS)) {
      unobserved[entityName] = {
        type: entity.entityType,
        reason: "unsupported-kind",
        detail: `no fountain read path for ${entity.entityType}`,
      };
      continue;
    }

    const live = await listKind(entity.entityType);
    if (live instanceof Error) {
      unobserved[entityName] = {
        type: entity.entityType,
        reason: "read-failed",
        detail: live.message,
      };
      continue;
    }

    const resourceName =
      typeof entity.props.name === "string" ? (entity.props.name as string) : entityName;
    const found = live.get(resourceName);
    if (!found) {
      // Observed absent: we asked, fountain said no → eligible for `create`.
      continue;
    }

    const owned = isChantOwned(found);
    if (options.owned && !owned) {
      unobserved[entityName] = {
        type: entity.entityType,
        reason: "filtered",
        detail: `"${resourceName}" exists but does not carry the ${"managed-by"}: chant marker`,
      };
      continue;
    }

    resources[entityName] = {
      type: entity.entityType,
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

  return observation(resources, unobserved);
}
