/**
 * Live introspection of Fly (flaps) resources — the read-back seam for chant's
 * plan/drift machinery (#767).
 *
 * The write path (flyApply, #739/#741) already GETs live state to decide
 * create/update/noop and to prune owned orphans. This surfaces that same read
 * side through the standard `describeResources` seam so core's change set
 * (packages/core/src/lifecycle/change-set.ts) and `chant lifecycle plan` can see
 * live Fly state and classify create/update/delete/adopt/noop.
 *
 * Peer of gcp/aws describe-resources: list what is live, key it by chant entity
 * name, attach an ownership verdict. Two-tier ownership, matching the applier
 * (#743):
 *
 *   - Machines carry the primary marker (`managed-by: chant`,
 *     FLY_METADATA_OWNERSHIP_KEYS), so their verdict is per-resource: `owned`
 *     when `isChantOwned(config.metadata)`, else `foreign`.
 *   - Volumes, IPs, and certificates carry no marker channel, so their boundary
 *     is the app (#741/#743): everything under a chant-managed app (one carrying
 *     the marker via its machines) is `owned`. When the `owned` filter asks for
 *     those types, this logs that ownership is inferred at the app boundary
 *     rather than silently returning everything, per the seam contract.
 *
 * Endpoint + auth reuse the applier verbatim (resolveEndpoint /
 * FLY_FLAPS_BASE_URL / FLY_API_TOKEN), so plan reads the same mudflaps or
 * real-Fly target flyApply writes. Secrets are apply-only (D7): flaps returns
 * only a digest, so they never enter a diff and are excluded here.
 */

import type { ObservationResult, ResourceMetadata, UnobservedEntity } from "@intentius/chant/lexicon";
import { normalizeObservation, observation, unobservedAll } from "@intentius/chant/observation";
import {
  buildChangeSet,
  renderChangeSet,
  type ChangeSet,
} from "@intentius/chant/lifecycle/change-set";
import {
  resolveEndpoint,
  defaultFlyHttp,
  parsePlan,
  isAppRequest,
  isMachineRequest,
  isVolumeRequest,
  isIpRequest,
  isCertRequest,
  appNameFromRequest,
  machineAppSegment,
  resourceAppSegment,
  resolveApp,
  isChantOwned,
  configEqual,
  listMachines,
  listVolumes,
  listIps,
  listCerts,
  ipType,
  declaredIpType,
  type FlyHttp,
  type FlyPlan,
  type FlapsRequest,
  type ApplyCtx,
} from "./op/activities/fly-apply";

/** The chant entity types the fly serializer emits, for the metadata `type` field. */
const TYPE = {
  app: "Fly::Machines::App",
  machine: "Fly::Machines::Machine",
  volume: "Fly::Machines::Volume",
  ip: "Fly::Machines::IPAddress",
  cert: "Fly::Machines::Certificate",
} as const;

/** Live machine states that mean the machine is gone or on its way out — not live. */
const TERMINAL_STATES = new Set(["destroyed", "destroying"]);

export interface DescribeResourcesOptions {
  environment: string;
  buildOutput: string;
  entityNames: string[];
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
  /** Restrict to chant-owned resources (#119). */
  owned?: boolean;
  /** flaps endpoint override (tests). Defaults to resolveEndpoint() → FLY_FLAPS_BASE_URL. */
  endpoint?: string;
}

function pruneUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** The serialized machine name flaps stores: an explicit `body.name`, else the entity name (mirrors applyMachine). */
function serializedName(req: FlapsRequest, entityName: string): string {
  return typeof req.body.name === "string" && req.body.name ? req.body.name : entityName;
}

/**
 * List live Fly resources over flaps and return them keyed by chant entity name,
 * each tagged with an ownership verdict the core change set reads to decide
 * whether an orphan is a delete (owned) or an adopt candidate (foreign). Reused
 * by `flyPlugin.describeResources`.
 *
 * `http` is injectable for tests; the default reuses the applier's fetch client
 * (bearer token from FLY_API_TOKEN).
 */
export async function describeResources(
  options: DescribeResourcesOptions,
  http: FlyHttp = defaultFlyHttp(),
  signal?: AbortSignal,
): Promise<ObservationResult> {
  const result: Record<string, ResourceMetadata> = {};
  const unobserved: Record<string, UnobservedEntity> = {};

  // Without a readable plan there is nothing to key a read by, so chant never
  // asks flaps anything — every declared entity is unobserved, not absent
  // (#1089). Returning an empty map here used to plan a create for each.
  if (!options.buildOutput) {
    return observation(
      result,
      unobservedAll(options.entities.keys(), "read-failed", "no fly plan in the build output to read back", options.entities),
    );
  }

  let plan: FlyPlan;
  try {
    plan = parsePlan(options.buildOutput);
  } catch (err) {
    return observation(
      result,
      unobservedAll(
        options.entities.keys(),
        "read-failed",
        `build output is not a readable fly plan: ${err instanceof Error ? err.message : String(err)}`,
        options.entities,
      ),
    );
  }

  const ctx: ApplyCtx = { base: resolveEndpoint({ endpoint: options.endpoint }) };
  const owned = options.owned ?? false;
  const entities = options.entities;
  const typeOf = (entityName: string, fallback: string): string =>
    entities.get(entityName)?.entityType ?? fallback;

  // Classify the declared plan (mirrors flyApply's dispatch). Secrets are
  // apply-only (D7) and never enter a diff, so they are not collected.
  const appReqs: Array<[string, FlapsRequest]> = [];
  const machineReqs: Array<[string, FlapsRequest]> = [];
  const volumeReqs: Array<[string, FlapsRequest]> = [];
  const ipReqs: Array<[string, FlapsRequest]> = [];
  const certReqs: Array<[string, FlapsRequest]> = [];
  for (const [entityName, req] of Object.entries(plan)) {
    if (isAppRequest(req)) appReqs.push([entityName, req]);
    else if (isMachineRequest(req)) machineReqs.push([entityName, req]);
    else if (isVolumeRequest(req)) volumeReqs.push([entityName, req]);
    else if (isIpRequest(req)) ipReqs.push([entityName, req]);
    else if (isCertRequest(req)) certReqs.push([entityName, req]);
  }

  const appNames = appReqs.map(([, r]) => appNameFromRequest(r));
  const soleApp = appNames.length === 1 ? appNames[0] : undefined;
  const owningApp = (req: FlapsRequest, segment: (endpoint: string) => string): string | undefined => {
    try {
      return resolveApp(segment(req.endpoint), soleApp);
    } catch {
      return undefined; // unresolved {app} placeholder — nothing to query
    }
  };

  // Reverse maps: a live resource's natural key → the chant entity that declares
  // it, so a declared+live resource keys back to the entity a re-apply touches;
  // an undeclared live resource falls through to its natural key (an orphan).
  const appEntityByName = new Map<string, string>();
  for (const [entityName, req] of appReqs) appEntityByName.set(appNameFromRequest(req), entityName);

  const machineEntity = new Map<string, string>(); // `${app} ${name}` → entityName
  const volumeEntity = new Map<string, string>(); // `${app} ${name}`
  const ipEntity = new Map<string, string>(); // `${app} ${family}`
  const certEntity = new Map<string, string>(); // `${app} ${hostname}`
  const appsToQuery = new Set<string>(appNames);

  /** An entity whose owning app can't be resolved is never queried — a hole, not an absence (#1089). */
  const unresolvedApp = (entityName: string): void => {
    const type = options.entities.get(entityName)?.entityType;
    unobserved[entityName] = {
      ...(type ? { type } : {}),
      reason: "read-failed",
      detail: "owning app could not be resolved from the plan (unresolved app placeholder)",
    };
  };

  for (const [entityName, req] of machineReqs) {
    const app = owningApp(req, machineAppSegment);
    if (!app) {
      unresolvedApp(entityName);
      continue;
    }
    appsToQuery.add(app);
    machineEntity.set(`${app} ${serializedName(req, entityName)}`, entityName);
  }
  for (const [entityName, req] of volumeReqs) {
    const app = owningApp(req, resourceAppSegment);
    if (!app) {
      unresolvedApp(entityName);
      continue;
    }
    appsToQuery.add(app);
    volumeEntity.set(`${app} ${serializedName(req, entityName)}`, entityName);
  }
  for (const [entityName, req] of ipReqs) {
    const app = owningApp(req, resourceAppSegment);
    if (!app) {
      unresolvedApp(entityName);
      continue;
    }
    appsToQuery.add(app);
    ipEntity.set(`${app} ${declaredIpType(req.body.type)}`, entityName);
  }
  for (const [entityName, req] of certReqs) {
    const app = owningApp(req, resourceAppSegment);
    if (!app) {
      unresolvedApp(entityName);
      continue;
    }
    appsToQuery.add(app);
    certEntity.set(`${app} ${String(req.body.hostname ?? "")}`, entityName);
  }

  /**
   * The `owned` filter withholds a live resource; it never proves one absent
   * (#1089). When the withheld resource is one a chant entity declares, record
   * the hole — dropping it silently is what turned "exists, but foreign" into a
   * proposed create. An undeclared live resource has no declared axis to
   * misreport, so it is simply not returned.
   */
  const withheld = (entityName: string | undefined, detail: string): void => {
    const declaredType = entityName ? options.entities.get(entityName)?.entityType : undefined;
    if (!entityName || !declaredType) return;
    unobserved[entityName] = { type: declaredType, reason: "filtered", detail };
  };

  /** Declared entities of one app whose breadth read never completed. */
  const breadthEntitiesOf = (app: string): string[] => {
    const prefix = `${app} `;
    const names: string[] = [];
    for (const map of [volumeEntity, ipEntity, certEntity]) {
      for (const [key, entityName] of map) if (key.startsWith(prefix)) names.push(entityName);
    }
    return names;
  };

  // The app-boundary log fires at most once per call, and only when the `owned`
  // filter reaches the metadata-less types (mirrors aws's degrade-to-log line).
  let loggedBoundary = false;
  const noteBoundaryInference = (): void => {
    if (loggedBoundary || !owned) return;
    loggedBoundary = true;
    console.warn(
      "[fly] volumes/ip_assignments/certificates carry no per-resource ownership marker — ownership is inferred at the app boundary (#741/#743); only resources under a chant-managed app are reported owned",
    );
  };

  for (const app of appsToQuery) {
    // One machine list per app: it drives both the machine verdicts and the
    // app-boundary decision (an app is chant-managed when any live machine is).
    const machines = (await listMachines(ctx, app, http, signal)).filter(
      (m) => !TERMINAL_STATES.has(m.state),
    );
    const appManaged = machines.some((m) => isChantOwned(m.config?.metadata));

    // App resource. No per-resource marker; the app-boundary evidence is its own
    // chant-owned machines. Absent that, ownership is left unset (unknown), so
    // the change set never proposes deleting an app it can't prove is chant's.
    const appRes = await http(
      "GET",
      `${ctx.base}/v1/apps/${encodeURIComponent(app)}`,
      undefined,
      undefined,
      signal,
    );
    if (appRes.status === 200) {
      const ownership = appManaged ? ("owned" as const) : undefined;
      if (owned && ownership !== "owned") {
        withheld(appEntityByName.get(app), "app has no chant-owned machine to prove ownership and --owned was requested");
      } else {
        const entityName = appEntityByName.get(app) ?? app;
        result[entityName] = {
          type: typeOf(entityName, TYPE.app),
          physicalId: app,
          status: "deployed",
          ownership,
          attributes: { app },
        };
      }
    }

    // Machines: precise per-marker verdict.
    for (const m of machines) {
      const isOwned = isChantOwned(m.config?.metadata);
      if (owned && !isOwned) {
        // Withheld by the owned filter — live and foreign, which is not absent.
        withheld(machineEntity.get(`${app} ${m.name}`), "live machine carries no chant ownership marker and --owned was requested");
        continue;
      }
      const entityName = machineEntity.get(`${app} ${m.name}`) ?? m.name;
      result[entityName] = {
        type: typeOf(entityName, TYPE.machine),
        physicalId: m.id,
        status: m.state,
        ownership: isOwned ? "owned" : "foreign",
        attributes: pruneUndefined({
          app,
          machineName: m.name,
          instanceId: m.instance_id,
          config: m.config,
        }),
      };
    }

    // ── Metadata-less breadth types (#741): app-boundary ownership. ──────────
    // Under a chant-managed app they are owned; otherwise ownership is unknown
    // and, under the `owned` filter, they are dropped (with a one-time note).
    const boundaryOwnership = appManaged ? ("owned" as const) : undefined;

    try {
      for (const v of await listVolumes(ctx, app, http, signal)) {
        if (owned && boundaryOwnership !== "owned") {
          noteBoundaryInference();
          withheld(volumeEntity.get(`${app} ${v.name}`), "volume sits under an app with no chant-owned machine and --owned was requested");
          continue;
        }
        if (owned) noteBoundaryInference();
        const entityName = volumeEntity.get(`${app} ${v.name}`) ?? v.name;
        result[entityName] = {
          type: typeOf(entityName, TYPE.volume),
          physicalId: v.id,
          status: v.state ?? "present",
          ownership: boundaryOwnership,
          attributes: pruneUndefined({ app, volumeName: v.name }),
        };
      }

      for (const ip of await listIps(ctx, app, http, signal)) {
        const family = ipType(ip.shared, ip.ip);
        if (owned && boundaryOwnership !== "owned") {
          noteBoundaryInference();
          withheld(ipEntity.get(`${app} ${family}`), "ip sits under an app with no chant-owned machine and --owned was requested");
          continue;
        }
        if (owned) noteBoundaryInference();
        const entityName = ipEntity.get(`${app} ${family}`) ?? `${app}/${family}`;
        result[entityName] = {
          type: typeOf(entityName, TYPE.ip),
          physicalId: ip.ip,
          status: "present",
          ownership: boundaryOwnership,
          attributes: pruneUndefined({ app, family, address: ip.ip }),
        };
      }

      for (const c of await listCerts(ctx, app, http, signal)) {
        if (owned && boundaryOwnership !== "owned") {
          noteBoundaryInference();
          withheld(certEntity.get(`${app} ${c.hostname}`), "certificate sits under an app with no chant-owned machine and --owned was requested");
          continue;
        }
        if (owned) noteBoundaryInference();
        const entityName = certEntity.get(`${app} ${c.hostname}`) ?? c.hostname;
        result[entityName] = {
          type: typeOf(entityName, TYPE.cert),
          physicalId: c.hostname,
          status: "present",
          ownership: boundaryOwnership,
          attributes: pruneUndefined({ app, hostname: c.hostname }),
        };
      }
    } catch (err) {
      // A breadth endpoint that is unreachable on this target leaves the diff to
      // machines + apps rather than failing the whole read — but the volumes,
      // ips and certs it would have reported were never read, so they are holes
      // rather than absences (#1089).
      const detail = `flaps breadth read failed for app "${app}": ${err instanceof Error ? err.message : String(err)}`;
      for (const entityName of breadthEntitiesOf(app)) {
        if (result[entityName]) continue; // already read before the failure
        const type = options.entities.get(entityName)?.entityType;
        unobserved[entityName] = { ...(type ? { type } : {}), reason: "read-failed", detail };
      }
    }
  }

  // Present wins: an entity that was read is never also a hole.
  for (const name of Object.keys(result)) delete unobserved[name];
  return observation(result, unobserved);
}

/**
 * Read-only plan (#767 §4): a `flyApply` dry-run. Reads live state via
 * {@link describeResources}, promotes it to core's typed change set, then
 * refines each declared+live machine's update/noop verdict with the applier's
 * own `configEqual`, so the plan matches exactly what a subsequent `flyApply`
 * would do — never mutating. `renderChangeSet` gives the human view.
 *
 * The core change set already computes create/delete/adopt/noop from
 * declared-vs-live + ownership; the `configEqual` refinement adds the
 * declared-vs-live *config* comparison for machines (core's own update signal is
 * snapshot-relative, which a stateless dry-run has no snapshot for).
 */
export async function flyPlan(
  options: DescribeResourcesOptions & {
    /** Previous snapshot resources, when reconciling drift since a snapshot. */
    observedThen?: Record<string, ResourceMetadata>;
  },
  http: FlyHttp = defaultFlyHttp(),
  signal?: AbortSignal,
): Promise<{ changeSet: ChangeSet; rendered: string }> {
  const observed = normalizeObservation(await describeResources(options, http, signal));
  const observedNow = observed.resources;
  const declared = new Set<string>(options.entities.keys());
  const cs = buildChangeSet(options.environment, {
    declared,
    observedNow,
    observedThen: options.observedThen,
    // Entities flaps could not be asked about stay `unobserved` in the plan
    // rather than being proposed as creates (#1089).
    unobserved: observed.unobserved,
  });

  // Declared config per entity, for the machine update/noop refinement.
  const declaredConfig = new Map<string, unknown>();
  try {
    for (const [entityName, req] of Object.entries(parsePlan(options.buildOutput))) {
      if (isMachineRequest(req)) declaredConfig.set(entityName, req.body.config);
    }
  } catch {
    // no plan to refine against
  }

  for (const entry of cs.entries) {
    if (entry.action !== "noop") continue;
    const declaredCfg = declaredConfig.get(entry.name);
    if (declaredCfg === undefined) continue; // not a declared machine
    const liveCfg = (observedNow[entry.name]?.attributes as { config?: unknown } | undefined)?.config;
    if (!configEqual(declaredCfg, liveCfg)) {
      entry.action = "update";
    }
  }

  return { changeSet: cs, rendered: renderChangeSet(cs) };
}
