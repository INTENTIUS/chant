/**
 * Live introspection of Render resources — the read-back seam for chant's
 * plan/drift machinery.
 *
 * The write path (renderApply) already GETs live state to decide
 * create/update/unchanged and to prune owned orphans. This surfaces that same
 * read side through the standard `describeResources` seam so core's change set
 * and `chant lifecycle plan` can see live Render state and classify
 * create/update/delete/adopt/noop.
 *
 * Peer of fly's describe-resources: list what is live, key it by chant entity
 * name, attach an ownership verdict. Two-tier ownership, matching the applier:
 *
 *   - Services and env groups carry the primary marker (`CHANT_MANAGED_BY`,
 *     RENDER_ENV_OWNERSHIP_KEYS) in their env vars, so their verdict is
 *     per-resource: `owned` when marked, else `foreign`.
 *   - Datastores, projects, environments, disks, custom domains, registry
 *     credentials, and webhooks carry no marker channel, so their verdict is
 *     `unknown` — the change set never escalates `unknown` to a delete. When
 *     the `owned` filter asks for those types, this logs that no verdict is
 *     available rather than silently returning everything.
 *
 * Endpoint + auth reuse the applier verbatim (resolveEndpoint /
 * RENDER_API_BASE_URL / RENDER_API_KEY), so plan reads the same target
 * renderApply writes. Undeclared chant-marked services and env groups in the
 * workspace are also returned (as orphans keyed by `<type>/<name>`), so a
 * declared-then-removed service shows up as a delete candidate.
 */

import type { ObservationResult, ResourceMetadata, UnobservedEntity } from "@intentius/chant/lexicon";
import { observation, unobservedAll } from "@intentius/chant/observation";
import { CATALOG, ENTITY_TYPES, ENTITY_TYPE_OF_SERVICE, catalogEntry, isServiceEntityType } from "./catalog";
import { isOwnerMarker, isRefMarker, type RenderPlan, type RenderRequest } from "./serializer";
import {
  resolveEndpoint,
  defaultRenderHttp,
  parsePlan,
  orderPlan,
  listAll,
  getOne,
  readServiceEnvVars,
  envVarsToMap,
  isChantOwned,
  resolveOwner,
  type RenderHttp,
  type ApplyCtx,
} from "./op/activities/render-apply";

export interface DescribeResourcesOptions {
  environment: string;
  buildOutput: string;
  entityNames: string[];
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
  /** Restrict to chant-owned resources (#119). */
  owned?: boolean;
  /** API endpoint override (tests). Defaults to resolveEndpoint() → RENDER_API_BASE_URL. */
  endpoint?: string;
  /** Workspace override (tests). Defaults to RENDER_OWNER_ID, else the sole visible owner. */
  ownerId?: string;
}

/** Live service/datastore states that mean "gone or going" — not live. */
const NOT_LIVE = new Set(["deleted", "deleting"]);

/** Live resource → chant status string. */
function statusOf(rec: Record<string, unknown>): string {
  if (typeof rec.status === "string") return rec.status; // datastores
  if (rec.suspended === "suspended") return "suspended";
  if (typeof rec.verificationStatus === "string") return rec.verificationStatus; // custom domains
  return "deployed";
}

/**
 * List live Render resources and return them keyed by chant entity name, each
 * tagged with an ownership verdict the core change set reads to decide whether
 * an orphan is a delete (owned) or an adopt candidate (foreign). Reused by
 * `renderPlugin.describeResources`.
 *
 * `http` is injectable for tests; the default reuses the applier's fetch client
 * (bearer token from RENDER_API_KEY).
 */
export async function describeResources(
  options: DescribeResourcesOptions,
  http: RenderHttp = defaultRenderHttp(),
  signal?: AbortSignal,
): Promise<ObservationResult> {
  const result: Record<string, ResourceMetadata> = {};
  const unobserved: Record<string, UnobservedEntity> = {};

  // Without a readable plan there is nothing to key a read by, so chant never
  // asks Render anything — every declared entity is unobserved, not absent.
  if (!options.buildOutput) {
    return observation(
      result,
      unobservedAll(options.entities.keys(), "read-failed", "no render plan in the build output to read back", options.entities),
    );
  }

  let plan: RenderPlan;
  try {
    plan = parsePlan(options.buildOutput);
  } catch (err) {
    return observation(
      result,
      unobservedAll(
        options.entities.keys(),
        "read-failed",
        `build output is not a readable render plan: ${err instanceof Error ? err.message : String(err)}`,
        options.entities,
      ),
    );
  }

  const ctx: ApplyCtx = { base: resolveEndpoint({ endpoint: options.endpoint }) };
  const owned = options.owned ?? false;
  const typeOf = (entityName: string, fallback: string): string =>
    options.entities.get(entityName)?.entityType ?? fallback;

  // The workspace: needed to scope every list. Resolved once; a failure here
  // is a whole-read failure (no credentials / no workspace), reported per entity.
  let ownerId: string;
  try {
    ownerId = await resolveOwner(ctx, { ownerId: options.ownerId }, http, signal);
  } catch (err) {
    return observation(
      result,
      unobservedAll(options.entities.keys(), "no-credentials", err instanceof Error ? err.message : String(err), options.entities),
    );
  }

  let ordered: Array<[string, RenderRequest]>;
  try {
    ordered = orderPlan(plan);
  } catch (err) {
    return observation(
      result,
      unobservedAll(options.entities.keys(), "read-failed", err instanceof Error ? err.message : String(err), options.entities),
    );
  }

  // Live ids by entity, so a child's `{ $ref }` (Disk.serviceId, Environment.
  // projectId, CustomDomain path) resolves to the parent's live id when the
  // parent exists. A missing parent means the child cannot exist yet — it is
  // reported absent, which is exactly the create the plan should propose.
  const liveId = new Map<string, string>();

  // Declared services and env groups by natural key, so the workspace-wide
  // marker scan below can tell an orphan from a declared one.
  const declaredServices = new Set<string>();
  const declaredGroups = new Set<string>();

  let loggedUnknown = false;
  const noteUnknown = (): void => {
    if (loggedUnknown || !owned) return;
    loggedUnknown = true;
    console.warn(
      "[render] datastores, projects, environments, disks, custom domains, registry credentials and webhooks carry no ownership marker — their verdict is unknown; --owned withholds them rather than guessing",
    );
  };

  for (const [entityName, req] of ordered) {
    const entry = catalogEntry(req.entityType);
    if (isServiceEntityType(req.entityType)) declaredServices.add(`${req.body.type}:${req.name}`);
    if (req.entityType === ENTITY_TYPES.envGroup) declaredGroups.add(req.name);

    // Resolve the path/body references this read depends on.
    let endpoint = req.endpoint;
    let unresolved = false;
    for (const [k, v] of Object.entries(req.pathParams ?? {})) {
      const id = isRefMarker(v) ? liveId.get(v.$ref) : typeof v === "string" ? v : undefined;
      if (!id) {
        unresolved = true;
        break;
      }
      endpoint = endpoint.replace(`{${k}}`, encodeURIComponent(id));
    }
    if (unresolved) continue; // parent absent → child absent (in neither map)

    const query: Record<string, string | undefined> = {};
    if (entry.filters.name) query.name = req.name;
    if (entry.filters.ownerId) query.ownerId = typeof req.body.ownerId === "string" && !isOwnerMarker(req.body.ownerId) ? req.body.ownerId : ownerId;
    let scopeId: string | undefined;
    if (req.entityType === ENTITY_TYPES.environment) {
      scopeId = isRefMarker(req.body.projectId) ? liveId.get(req.body.projectId.$ref) : typeof req.body.projectId === "string" ? req.body.projectId : undefined;
      if (!scopeId) continue;
      query.projectId = scopeId;
    }
    if (req.entityType === ENTITY_TYPES.disk) {
      scopeId = isRefMarker(req.body.serviceId) ? liveId.get(req.body.serviceId.$ref) : typeof req.body.serviceId === "string" ? req.body.serviceId : undefined;
      if (!scopeId) continue;
      query.serviceId = scopeId;
    }
    const listPath = req.entityType === ENTITY_TYPES.customDomain ? endpoint : entry.collection;

    let candidates: Record<string, unknown>[];
    try {
      candidates = await listAll(ctx, listPath, query, entry.listKey, http, signal);
    } catch (err) {
      unobserved[entityName] = {
        type: req.entityType,
        reason: "read-failed",
        detail: err instanceof Error ? err.message : String(err),
        queried: `${ctx.base}${listPath}`,
      };
      continue;
    }
    const live = candidates.find((c) => {
      if (c.name !== req.name) return false;
      if (isServiceEntityType(req.entityType) && c.type !== req.body.type) return false;
      if (scopeId && req.entityType === ENTITY_TYPES.environment && c.projectId !== scopeId) return false;
      if (scopeId && req.entityType === ENTITY_TYPES.disk && c.serviceId !== scopeId) return false;
      return true;
    });
    if (!live || (typeof live.status === "string" && NOT_LIVE.has(live.status))) continue; // absent

    const id = typeof live.id === "string" ? live.id : undefined;
    if (id) liveId.set(entityName, id);

    // Ownership verdict.
    let ownership: ResourceMetadata["ownership"];
    if (entry.marked && id) {
      let env: Record<string, string>;
      if (isServiceEntityType(req.entityType)) {
        env = await readServiceEnvVars(ctx, id, http, signal);
      } else {
        const full = (await getOne(ctx, `${entry.collection}/${id}`, http, signal)) ?? live;
        env = envVarsToMap(full.envVars);
      }
      ownership = isChantOwned(env) ? "owned" : "foreign";
    } else {
      ownership = "unknown";
      noteUnknown();
    }

    if (owned && ownership !== "owned") {
      unobserved[entityName] = {
        type: req.entityType,
        reason: "filtered",
        detail:
          ownership === "foreign"
            ? "live resource carries no chant ownership marker and --owned was requested"
            : "resource kind has no ownership marker channel and --owned was requested",
      };
      continue;
    }

    result[entityName] = {
      type: typeOf(entityName, req.entityType),
      physicalId: id,
      status: statusOf(live),
      lastUpdated: typeof live.updatedAt === "string" ? live.updatedAt : undefined,
      ownership,
      attributes: pruneUndefined({
        id,
        name: live.name,
        dashboardUrl: live.dashboardUrl,
        type: live.type,
        region: (live.serviceDetails as Record<string, unknown> | undefined)?.region ?? live.region,
        environmentId: live.environmentId,
        projectId: live.projectId,
        serviceId: live.serviceId,
      }),
    };
  }

  // Orphans: chant-marked services and env groups in the workspace that the
  // plan does not declare — delete candidates for the change set.
  try {
    for (const svc of await listAll(ctx, "/services", { ownerId }, "service", http, signal)) {
      const id = typeof svc.id === "string" ? svc.id : undefined;
      const name = typeof svc.name === "string" ? svc.name : "";
      const type = typeof svc.type === "string" ? svc.type : "";
      if (!id || declaredServices.has(`${type}:${name}`)) continue;
      const env = await readServiceEnvVars(ctx, id, http, signal);
      if (!isChantOwned(env)) continue;
      const entityType = ENTITY_TYPE_OF_SERVICE[type] ?? ENTITY_TYPES.webService;
      result[`${CATALOG[entityType].kind}/${name}`] = {
        type: entityType,
        physicalId: id,
        status: statusOf(svc),
        lastUpdated: typeof svc.updatedAt === "string" ? svc.updatedAt : undefined,
        ownership: "owned",
        attributes: pruneUndefined({ id, name, dashboardUrl: svc.dashboardUrl, type }),
      };
    }
    for (const grp of await listAll(ctx, "/env-groups", { ownerId }, "envGroup", http, signal)) {
      const id = typeof grp.id === "string" ? grp.id : undefined;
      const name = typeof grp.name === "string" ? grp.name : "";
      if (!id || declaredGroups.has(name)) continue;
      const full = (await getOne(ctx, `/env-groups/${id}`, http, signal)) ?? grp;
      if (!isChantOwned(envVarsToMap(full.envVars))) continue;
      result[`EnvGroup/${name}`] = {
        type: ENTITY_TYPES.envGroup,
        physicalId: id,
        status: "deployed",
        lastUpdated: typeof grp.updatedAt === "string" ? grp.updatedAt : undefined,
        ownership: "owned",
        attributes: { id, name },
      };
    }
  } catch (err) {
    console.warn(`[render] orphan scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return observation(result, unobserved);
}

function pruneUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
