/**
 * fountain deep observation (#1217) — the fountain row of the deep-observe
 * contract (#1014).
 *
 * `describeResources()` (./describe-resources.ts) answers whether a declared
 * Environment/Vault/Agent exists and hands back its id and timestamps. That
 * misses the drift the design was written for: an environment hand-edited in
 * the fountain UI from `networking_type: limited` to `unrestricted`, an
 * `allowed_vault_ids` allowlist widened, a skill repointed at an unpinned
 * branch, a secret added to a reviewed sandbox. All of it lives one level
 * down, in properties nobody was reading.
 *
 * ## The read is the thin path's read
 *
 * Transport, endpoint and auth are the applier's, unchanged
 * (`FOUNTAIN_ENDPOINT` / `FOUNTAIN_TOKEN`), so plan reads the instance
 * `fountainApply` writes. And the depth is free: fountain's list endpoints
 * render the full record — `GET /api/environments` returns every configuration
 * field the request schema accepts, not a summary — so there is no per-resource
 * follow-up GET the way the AWS row needs Cloud Control on top of
 * `describe-stack-resources`. One list per declared kind, cached, exactly as
 * the thin path does it.
 *
 * ## The payload passes through
 *
 * fountain's JSON views name their fields the same way the request schema does
 * (`networking_type`, `env_vars`, `skills`), so the live tree and the declared
 * tree already speak one vocabulary — the AWS situation, not temporal's. The
 * payload is therefore forwarded as-is and the noise rules
 * (./deep-observe-hooks.ts) do the rest. A field fountain adds in a later
 * release surfaces as `undeclared` until the table names it, which is the
 * deliberate trade: visible and fixable beats silently dropped.
 *
 * One exception, and it is the reference edge. chant declares an agent's
 * environment as a typed reference (`environment`), fountain stores the id it
 * resolved to (`environment_id`). Passing the id through would report
 * `<undeclared> -> <uuid>` on every clean read, so where source did not author
 * `environment_id` itself the id is resolved back to the environment's name and
 * emitted as `environment` — the same translation `exportResources()` does for
 * the import path.
 *
 * ## Secrets: presence, never keys, never values
 *
 * Values are write-only upstream and are never read here at all. The secrets
 * sub-resource is listed (keys and timestamps only) so that an environment or
 * vault which declares no secrets and has some — somebody adding one to a
 * locked-down sandbox — reports as drift. Core's key-name mask collapses the
 * whole `secrets` node on both trees, so what a diff row can say is that
 * secrets exist, not which. See the hooks module for why the key set itself is
 * not expressible until fountain#148 lands.
 *
 * That listing is one extra request per observed Environment and Vault. A
 * fountain tenant holds a handful of each, and the alternative — inferring
 * presence from the newer payload's `secret_count` — would silently report
 * "no secrets" against any instance predating that field.
 */

import type {
  DeepObservationResult,
  DeepResourceObservation,
  UnobservedEntity,
} from "@intentius/chant/lexicon";
import { deepObservation, normalizeDeepProperties } from "@intentius/chant/deep-observation";
import { unobservedAll } from "@intentius/chant/observation";
import {
  resolveEndpoint,
  defaultFountainHttp,
  isChantOwned,
  OWNERSHIP_KEY,
  OWNERSHIP_VALUE,
  type FountainHttp,
} from "./op/activities/fountain-apply";
import {
  fountainDeepNormalizationHooks,
  ENVIRONMENT_TYPE,
  VAULT_TYPE,
  AGENT_TYPE,
} from "./deep-observe-hooks";

// Re-exported so a dynamic importer of this module gets the reader and its
// hooks from one place. `plugin.ts` imports the hooks separately and
// statically, because core normalizes the declared tree with them whether or
// not a live read ever happens.
export { fountainDeepNormalizationHooks };

const KIND_PATHS: Record<string, string> = {
  [ENVIRONMENT_TYPE]: "environments",
  [VAULT_TYPE]: "vaults",
  [AGENT_TYPE]: "agents",
};

/** Kinds whose secrets live in a sub-resource rather than the record itself. */
const SECRET_BEARING: ReadonlySet<string> = new Set([ENVIRONMENT_TYPE, VAULT_TYPE]);

export interface FountainDeepObserveOptions {
  environment: string;
  buildOutput?: string;
  entityNames: string[];
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
  stack?: string;
  /** Restrict to resources carrying the `managed-by: chant` marker. */
  owned?: boolean;
  /** Endpoint override (tests). Defaults to resolveEndpoint(). */
  endpoint?: string;
}

/** The fields this reader reads by name off a live record. Everything else passes through. */
interface LiveRecord extends Record<string, unknown> {
  id: string;
  name: string;
  metadata?: Record<string, unknown>;
  environment_id?: string | null;
}

/** One list per kind, shared by every entity of that kind — including a failure. */
class KindLists {
  private readonly lists = new Map<string, Promise<Map<string, LiveRecord>>>();

  constructor(private readonly http: FountainHttp) {}

  byName(entityType: string): Promise<Map<string, LiveRecord>> {
    const cached = this.lists.get(entityType);
    if (cached) return cached;

    const path = KIND_PATHS[entityType];
    const pending = (async () => {
      const { status, json } = await this.http("GET", `/api/${path}`);
      if (status !== 200) throw new Error(`list ${path} returned ${status}`);
      const data = (json as { data?: LiveRecord[] })?.data ?? [];
      return new Map(data.map((r) => [r.name, r]));
    })();

    this.lists.set(entityType, pending);
    return pending;
  }
}

/**
 * The keys of a resource's secrets, sorted. Never the values — the API does not
 * return them and this never asks. Returns `undefined` when there are none, so
 * an environment without secrets carries no `secrets` path at all: an empty
 * list is itself a value, and reporting one against a declaration that has none
 * would be noise wearing the shape of drift.
 */
async function secretKeys(
  http: FountainHttp,
  kindPath: string,
  id: string,
): Promise<Array<{ key: string }> | undefined> {
  const { status, json } = await http("GET", `/api/${kindPath}/${id}/secrets`);
  if (status !== 200) throw new Error(`list ${kindPath}/${id}/secrets returned ${status}`);
  const data = (json as { data?: Array<{ key?: unknown }> })?.data ?? [];
  const keys = data
    .map((s) => s.key)
    .filter((k): k is string => typeof k === "string")
    .sort();
  return keys.length > 0 ? keys.map((key) => ({ key })) : undefined;
}

/**
 * The live property tree for an agent, with the reference edge put back into
 * the vocabulary source writes it in (see the module doc).
 */
function agentProperties(
  record: LiveRecord,
  declared: Record<string, unknown>,
  environmentNameById: Map<string, string>,
): Record<string, unknown> {
  const tree: Record<string, unknown> = { ...record };
  if (declared.environment_id !== undefined) return tree;

  const id = record.environment_id;
  if (typeof id !== "string") return tree;
  const name = environmentNameById.get(id);
  // An id with no environment behind it should not exist (the column carries a
  // foreign key), but if it does, the raw id is the honest thing to report.
  if (!name) return tree;

  delete tree.environment_id;
  tree.environment = name;
  return tree;
}

/**
 * Read the live property tree for each declared fountain entity.
 *
 * `http` is injectable for tests; the default reuses the applier's fetch client
 * (bearer token from FOUNTAIN_TOKEN). A missing token is the whole-lexicon
 * failure the thin path already names — every declared entity NOT-OBSERVED with
 * `no-credentials`, never an empty tree, which would read as "nothing drifted".
 */
export async function observeResourcesDeepFountain(
  options: FountainDeepObserveOptions,
  injected?: FountainHttp,
): Promise<DeepObservationResult> {
  const names = [...options.entities.keys()];

  let http = injected;
  if (!http) {
    const token = process.env.FOUNTAIN_TOKEN;
    if (!token) {
      return deepObservation(
        {},
        unobservedAll(
          names,
          "no-credentials",
          "FOUNTAIN_TOKEN is not set — cannot read live fountain state",
          options.entities,
        ),
      );
    }
    http = defaultFountainHttp(resolveEndpoint({ endpoint: options.endpoint }), token);
  }

  const lists = new KindLists(http);
  const resources: Record<string, DeepResourceObservation> = {};
  const unobserved: Record<string, UnobservedEntity> = {};

  // Built lazily and only for agents, so a project that declares no agent never
  // pays for the environments list it would not otherwise read.
  let environmentNameById: Map<string, string> | undefined;
  const environmentNames = async (): Promise<Map<string, string>> => {
    if (!environmentNameById) {
      const byName = await lists.byName(ENVIRONMENT_TYPE);
      environmentNameById = new Map([...byName.values()].map((r) => [r.id, r.name]));
    }
    return environmentNameById;
  };

  for (const [entityName, { entityType, props }] of options.entities) {
    if (!(entityType in KIND_PATHS)) {
      unobserved[entityName] = {
        type: entityType,
        reason: "unsupported-kind",
        detail: `no fountain deep reader for ${entityType}`,
      };
      continue;
    }

    const resourceName = typeof props.name === "string" ? props.name : entityName;

    try {
      const byName = await lists.byName(entityType);
      const record = byName.get(resourceName);

      // Not deployed. The thin read already reports the absence (#1089);
      // restating it here as a property hole would turn one finding into two.
      if (!record) continue;

      if (options.owned && !isChantOwned(record)) {
        unobserved[entityName] = {
          type: entityType,
          reason: "filtered",
          detail: `"${resourceName}" exists but does not carry the ${OWNERSHIP_KEY}: ${OWNERSHIP_VALUE} marker`,
        };
        continue;
      }

      let tree: Record<string, unknown>;
      if (entityType === AGENT_TYPE) {
        tree = agentProperties(record, props, await environmentNames());
      } else {
        tree = { ...record };
      }

      if (SECRET_BEARING.has(entityType)) {
        const secrets = await secretKeys(http, KIND_PATHS[entityType], record.id);
        if (secrets) tree.secrets = secrets;
      }

      resources[entityName] = {
        type: entityType,
        physicalId: record.id,
        properties: normalizeDeepProperties(tree, {
          entityType,
          side: "live",
          hooks: fountainDeepNormalizationHooks,
        }),
      };
    } catch (err) {
      // Per-entity, with the reason. A partial property surface — a failed
      // secrets listing, a failed kind list — must never arrive as a clean
      // tree, because a clean tree is a claim that nothing drifted.
      unobserved[entityName] = {
        type: entityType,
        reason: "read-failed",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return deepObservation(resources, unobserved);
}
