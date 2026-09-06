/**
 * fountain deep observation (#1217) — the fountain row of the deep-observe
 * contract (#1014).
 *
 * `describeResources()` (./describe-resources.ts) answers whether a declared
 * resource exists and hands back its id and timestamps. That misses the drift
 * the design was written for: an environment hand-edited in the fountain UI
 * from `networking_type: limited` to `unrestricted`, an `allowed_vault_ids`
 * allowlist widened, a skill repointed at an unpinned branch, a secret added to
 * a reviewed sandbox, a schedule someone paused. All of it lives one level
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
 * the thin path does it, through the same `FountainLists` (./live-identity.ts)
 * so the two readers index a live record under the same key.
 *
 * ## The payload passes through
 *
 * fountain's JSON views name their fields the same way the request schema does
 * (`networking_type`, `env_vars`, `skills`), so the live tree and the declared
 * tree already speak one vocabulary — the AWS situation, not temporal's. The
 * payload is therefore forwarded as-is and the noise rules
 * (./deep-observe-hooks.ts) do the rest. A field fountain adds in a later
 * release surfaces as held elsewhere until the table names it (#2160: source
 * never set it, so it is not drift and is never proposed for update), which is
 * the deliberate trade: visible and fixable beats silently dropped.
 *
 * The exceptions are the reference edges, and there is one per kind that has
 * one. chant declares an agent's environment as a typed reference
 * (`environment`), fountain stores the id it resolved to (`environment_id`).
 * Passing the id through would report `<undeclared> -> <uuid>` on every clean
 * read, so where source did not author the id field itself the id is resolved
 * back to the target's name and emitted under the prop an author writes — the
 * same translation `exportResources()` does for the import path. A schedule's
 * `agent_id` becomes `teammate`; a teammate's environment and vault ids become
 * `environment` and `vault`.
 *
 * An agent's two allowlists are the same edge in list form.
 * `allowed_vault_ids` and `allowed_environment_ids` are uuid columns upstream
 * and references in source — `Steward` writes the `Vault` declaration itself
 * into the first — so each live id is put back into whichever form the
 * declaration used for that resource before the tree is normalized (#2176).
 * ./allowlist-refs.ts holds that rule and the applier's opposite one (#2166)
 * together.
 *
 * A teammate is the one kind whose live payload is not its record. `GET
 * /api/team` renders a roster row: the agent embedded whole, the current
 * conversation, presence, unread state, the last turn, usage. Almost none of
 * that is authored, and the three fields that are — the agent, and the
 * environment and vault the team conversation was launched with — are nested
 * rather than top-level. So a teammate is projected onto its four declarable
 * props instead of passed through, and ./deep-observe-hooks.ts prunes the
 * render fields on both sides in case a future payload carries them flat.
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
  referencedName,
  type LiveRecord,
} from "./live-identity";
import {
  ALLOWLIST_FIELDS,
  allowlistOf,
  allowlistToDeclared,
  declaredAllowlistRefs,
  type AllowlistField,
} from "./allowlist-refs";
import {
  fountainDeepNormalizationHooks,
  ENVIRONMENT_TYPE,
  VAULT_TYPE,
  AGENT_TYPE,
  TEAMMATE_TYPE,
  SCHEDULE_TYPE,
} from "./deep-observe-hooks";

// Re-exported so a dynamic importer of this module gets the reader and its
// hooks from one place. `plugin.ts` imports the hooks separately and
// statically, because core normalizes the declared tree with them whether or
// not a live read ever happens.
export { fountainDeepNormalizationHooks };

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

/** The id→name lookups a reference translation needs, resolved on first use. */
interface NameLookups {
  environment(): Promise<Map<string, string>>;
  vault(): Promise<Map<string, string>>;
  agent(): Promise<Map<string, string>>;
  teammate(): Promise<ReadonlyMap<string, LiveRecord>>;
  /** The fountain name a declared reference prop points at, or nothing. */
  declaredName(value: unknown): string | undefined;
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
 * Replace a server-resolved id with the name an author writes, unless source
 * authored the id field itself — in which case the id IS the declared
 * vocabulary and translating it would manufacture drift.
 */
function translateRef(
  tree: Record<string, unknown>,
  declared: Record<string, unknown>,
  idField: string,
  prop: string,
  names: Map<string, string>,
): void {
  if (declared[idField] !== undefined) return;
  const id = tree[idField];
  if (typeof id !== "string") return;
  const name = names.get(id);
  // An id with nothing behind it should not exist (the column carries a foreign
  // key), but if it does, the raw id is the honest thing to report.
  if (!name) return;
  delete tree[idField];
  tree[prop] = name;
}

/**
 * The live property tree for an agent, with the reference edge put back into
 * the vocabulary source writes it in (see the module doc).
 */
async function agentProperties(
  record: LiveRecord,
  declared: Record<string, unknown>,
  names: NameLookups,
): Promise<Record<string, unknown>> {
  const tree: Record<string, unknown> = { ...record };
  if (declared.environment_id === undefined && typeof record.environment_id === "string") {
    translateRef(tree, declared, "environment_id", "environment", await names.environment());
  }
  await translateAllowlists(tree, declared, names);
  return tree;
}

/** Which list each allowlist field's ids are looked up in. */
const ALLOWLIST_LOOKUP: Record<AllowlistField, (names: NameLookups) => Promise<Map<string, string>>> = {
  allowed_vault_ids: (names) => names.vault(),
  allowed_environment_ids: (names) => names.environment(),
};

/**
 * The agent's two allowlists, put back into the vocabulary the declaration
 * wrote them in (#2176).
 *
 * The applier resolves a vault name in `allowed_vault_ids` to its uuid before
 * sending (#2166), so a steward that scopes a vault applies cleanly and then
 * reads back as a uuid the declaration never mentions. Without this, one line
 * about `allowed_vault_ids` sits on every `chant lifecycle diff --live` of an
 * estate that is exactly in sync. ./allowlist-refs.ts holds the rule both
 * directions share and says what each entry translates to.
 *
 * The empty and absent states are untouched: `[]` still reads as `[]`, and a
 * field fountain did not return is still not in the tree.
 */
async function translateAllowlists(
  tree: Record<string, unknown>,
  declared: Record<string, unknown>,
  names: NameLookups,
): Promise<void> {
  for (const field of ALLOWLIST_FIELDS) {
    const entries = allowlistOf(tree, field);
    if (!entries || entries.length === 0) continue;
    const byId = await ALLOWLIST_LOOKUP[field](names);
    const refs = declaredAllowlistRefs(allowlistOf(declared, field), names.declaredName);
    tree[field] = allowlistToDeclared(entries, (id) => byId.get(id), refs);
  }
}

/**
 * The four authored props of a teammate, read off a roster row: its name, the
 * agent it is, and the environment and vault its team conversation was
 * launched with. Everything else on the row is a render (see the module doc).
 */
async function teammateProperties(
  record: LiveRecord,
  declared: Record<string, unknown>,
  names: NameLookups,
): Promise<Record<string, unknown>> {
  const conversation =
    record.conversation && typeof record.conversation === "object"
      ? (record.conversation as Record<string, unknown>)
      : {};
  const tree: Record<string, unknown> = {};
  if (typeof record.name === "string") tree.name = record.name;

  const agentId = typeof record.agent_id === "string" ? record.agent_id : undefined;
  const embedded =
    record.agent && typeof record.agent === "object"
      ? (record.agent as Record<string, unknown>)
      : undefined;
  if (typeof embedded?.name === "string") tree.agent = embedded.name;
  else if (agentId) {
    tree.agent_id = agentId;
    translateRef(tree, declared, "agent_id", "agent", await names.agent());
  }

  for (const [idField, prop, lookup] of [
    ["environment_id", "environment", names.environment],
    ["vault_id", "vault", names.vault],
  ] as const) {
    const id = record[idField] ?? conversation[idField];
    if (typeof id !== "string") continue;
    tree[idField] = id;
    translateRef(tree, declared, idField, prop, await lookup());
  }

  return tree;
}

/**
 * A schedule's payload is its record, so it passes through — with `agent_id`
 * resolved back to the `teammate` reference chant declares it as.
 */
async function scheduleProperties(
  record: LiveRecord,
  declared: Record<string, unknown>,
  names: NameLookups,
): Promise<Record<string, unknown>> {
  const tree: Record<string, unknown> = { ...record };
  if (declared.agent_id !== undefined || typeof record.agent_id !== "string") return tree;
  const teammate = (await names.teammate()).get(record.agent_id)?.name;
  if (typeof teammate !== "string") return tree;
  delete tree.agent_id;
  tree.teammate = teammate;
  return tree;
}

async function liveProperties(
  entityType: string,
  record: LiveRecord,
  declared: Record<string, unknown>,
  names: NameLookups,
): Promise<Record<string, unknown>> {
  if (entityType === AGENT_TYPE) return agentProperties(record, declared, names);
  if (entityType === TEAMMATE_TYPE) return teammateProperties(record, declared, names);
  if (entityType === SCHEDULE_TYPE) return scheduleProperties(record, declared, names);
  return { ...record };
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

  const lists = new FountainLists(http);
  const index = nameIndex(options.entities);
  const resources: Record<string, DeepResourceObservation> = {};
  const unobserved: Record<string, UnobservedEntity> = {};

  // Lazy, and each underlying list is fetched at most once by `FountainLists`,
  // so a project that declares no agent never pays for the environments list it
  // would not otherwise read.
  const lookups: NameLookups = {
    environment: () => lists.nameById(ENVIRONMENT_TYPE),
    vault: () => lists.nameById(VAULT_TYPE),
    agent: () => lists.nameById(AGENT_TYPE),
    teammate: () => lists.roster(),
    declaredName: (value) => referencedName(value, index),
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

    const key = declaredKey(entityType, entityName, props, index);
    if (key === undefined) {
      unobserved[entityName] = {
        type: entityType,
        reason: "read-failed",
        detail: `"${entityName}" does not resolve to a fountain identity — a schedule needs a teammate reference, a webhook a url`,
      };
      continue;
    }

    try {
      const byKey = await lists.byKey(entityType);
      const record = byKey.get(key);

      // Not deployed. The thin read already reports the absence (#1089);
      // restating it here as a property hole would turn one finding into two.
      if (!record) continue;

      if (options.owned) {
        const ownership = ownershipOf(entityType, record, await lists.rosterFor(entityType));
        if (ownership !== "owned") {
          unobserved[entityName] = {
            type: entityType,
            reason: "filtered",
            detail:
              ownership === "unknown"
                ? `"${key}" exists but its ownership cannot be established — ${ownershipGap(entityType)}`
                : `"${key}" exists but does not carry the ${OWNERSHIP_KEY}: ${OWNERSHIP_VALUE} marker`,
          };
          continue;
        }
      }

      const tree = await liveProperties(entityType, record, props, lookups);

      if (SECRET_BEARING.has(entityType)) {
        const secrets = await secretKeys(http, KIND_PATHS[entityType], String(record.id));
        if (secrets) tree.secrets = secrets;
      }

      // A teammate has no id of its own — it IS an agent on the reserved team
      // channel — so the agent's id is its physical identity, same as the thin
      // read reports.
      const physicalId = entityType === TEAMMATE_TYPE ? record.agent_id : record.id;

      resources[entityName] = {
        type: entityType,
        ...(typeof physicalId === "string" ? { physicalId } : {}),
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
