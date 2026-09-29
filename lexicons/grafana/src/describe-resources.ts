/**
 * `describeResources()` for grafana (#2946): does each declared dashboard
 * and datasource exist in the environment's Grafana, and whose is it.
 *
 * Runs on core's observer harness. `bind()` resolves the environment's
 * Grafana (`grafana.profiles.<env>`, else `GRAFANA_URL`) and discovers which
 * dashboard API it serves; each entity is one GET, by the uid the build gives
 * it. Verdicts:
 *
 * | Entity | Read | 404 | Not readable |
 * |---|---|---|---|
 * | `Dashboard` | `/apis/dashboard.grafana.app/<v>/.../dashboards/<uid>` (Grafana 11: `/api/dashboards/uid/<uid>`) | absent | a v2-stored dashboard the server does not serve at v2: `unsupported-kind` |
 * | `Datasource`, `ExternalDatasource` | `/api/datasources/uid/<uid>` | absent | |
 * | a panel, row, query or variable | its dashboard's read (./members.ts) | its dashboard's | its dashboard's |
 * | `DashboardProvider` | none: a provisioning-file setting Grafana serves no API for | | `unsupported-kind` |
 *
 * A dashboard Grafana stores as v2 is read at v2 and converted (#2947);
 * its metadata says `schema: "v2"` and lists what the classic form cannot
 * hold under `v2Lossy`.
 *
 * A refused token is `no-credentials` for every entity, a missing binding
 * `no-binding`, anything else `read-failed`, never absent.
 *
 * Ownership is read where Grafana has a channel (./ownership.ts): a
 * dashboard over `/apis` resolves `owned` or `foreign`; a dashboard over the
 * legacy API and every datasource say `unknown`, and an `owned: true` read
 * withholds them as `filtered`, since it cannot show they are chant's.
 */

import type { ResourceMetadata } from "@intentius/chant/lexicon";
import {
  observeEntities,
  type DeclaredEntity,
  type DescribeResourcesResult,
  type EntityObservation,
  type ObserverAdapter,
} from "@intentius/chant/observation";
import { bindGrafana, classifyGrafanaFailure, type BindOptions } from "./api/bind";
import { GrafanaApiError, type GrafanaClient } from "./api/client";
import { classicDashboardOf, dashboardApi, readDashboard } from "./api/dashboards";
import { readDatasource } from "./api/datasources";
import { DASHBOARD_PROVIDER_TYPE, DASHBOARD_TYPE } from "./dashboard";
import { DATASOURCE_TYPE, EXTERNAL_DATASOURCE_TYPE } from "./datasource";
import { dashboardMembers, isDashboardPart } from "./members";
import { chantProviderNames, dashboardOwnership, ownershipGap } from "./ownership";
import { slugUid } from "./util";

export interface GrafanaObserveOptions extends Omit<BindOptions, "environment"> {
  environment: string;
  buildOutput?: string;
  entityNames: string[];
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
  owned?: boolean;
}

/** The uid a declared dashboard or datasource has in Grafana: the one the build gives it. */
export function declaredUid(name: string, entityType: string, props: Record<string, unknown>): string | undefined {
  if (typeof props.uid === "string" && props.uid !== "") return props.uid;
  if (entityType === DASHBOARD_TYPE) return slugUid(name || String(props.title ?? ""));
  if (entityType === DATASOURCE_TYPE && typeof props.name === "string") return slugUid(props.name);
  return undefined;
}

/** What `unsupported-kind` says about a provider. */
export const PROVIDER_NOT_OBSERVABLE =
  "a dashboard provider is a setting in Grafana's provisioning file, which Grafana serves no API for; its dashboards are observed instead";

/** What `unsupported-kind` says about a panel, row, query or variable that no declared dashboard holds. */
export const ORPHAN_PART =
  "panels, rows, queries and variables exist in Grafana only inside a dashboard, and no declared dashboard holds this one";

/** A GrafanaApiError as the harness's per-entity verdict; anything else is rethrown for the harness to record. */
function unobservedFrom(err: unknown): EntityObservation {
  if (err instanceof GrafanaApiError) return { unobserved: classifyGrafanaFailure(err) };
  throw err;
}

async function observeDashboard(client: GrafanaClient, uid: string, providers: ReadonlySet<string>, owned: boolean | undefined): Promise<EntityObservation> {
  let read;
  try {
    read = await readDashboard(client, uid);
  } catch (err) {
    return unobservedFrom(err);
  }
  if ("absent" in read) return { absent: true, queried: read.address };
  const live = read.present;
  const classic = classicDashboardOf(live);
  if ("unsupported" in classic) {
    return { unobserved: { reason: "unsupported-kind", detail: `dashboard "${uid}" is not readable: ${classic.unsupported}` }, queried: live.address };
  }
  const { ownership, marker } = dashboardOwnership(live, providers);
  if (owned && ownership !== "owned") {
    return {
      unobserved: {
        reason: "filtered",
        detail: `dashboard "${uid}" exists but ${ownership === "unknown" ? "its ownership cannot be read" : "is not chant's"}: ${ownershipGap(live)}`,
      },
      queried: live.address,
    };
  }
  const metadata = (live.raw.metadata ?? {}) as { generation?: unknown };
  const legacyVersion = (live.raw.meta as { version?: unknown } | undefined)?.version;
  const managerId = live.annotations["grafana.app/managerId"];
  const meta: ResourceMetadata = {
    type: DASHBOARD_TYPE,
    physicalId: uid,
    status: "PRESENT",
    ownership,
    ...(marker ? { marker } : {}),
    attributes: {
      title: classic.json.title,
      via: live.via,
      ...(live.folderUid ? { folderUid: live.folderUid } : {}),
      // Grafana's save counter: a UI save moves it, so a snapshot diff sees the edit too.
      ...(typeof metadata.generation === "number" ? { generation: metadata.generation } : {}),
      ...(typeof legacyVersion === "number" ? { version: legacyVersion } : {}),
      ...(managerId ? { managerId } : {}),
      ...(classic.warnings !== undefined ? { schema: "v2", ...(classic.warnings.length > 0 ? { v2Lossy: classic.warnings } : {}) } : {}),
    },
  };
  return { present: meta, queried: live.address };
}

async function observeDatasource(client: GrafanaClient, entity: DeclaredEntity, uid: string, owned: boolean | undefined): Promise<EntityObservation> {
  let read;
  try {
    read = await readDatasource(client, uid);
  } catch (err) {
    return unobservedFrom(err);
  }
  if ("absent" in read) return { absent: true, queried: read.address };
  if (owned) {
    return {
      unobserved: { reason: "filtered", detail: `datasource "${uid}" exists but its ownership cannot be read: Grafana's datasource API returns no labels or annotations` },
      queried: read.address,
    };
  }
  const ds = read.present;
  return {
    present: {
      type: entity.type,
      physicalId: uid,
      status: "PRESENT",
      ownership: "unknown",
      attributes: {
        name: ds.name,
        type: ds.type,
        ...(typeof ds.readOnly === "boolean" ? { readOnly: ds.readOnly } : {}),
        ...(typeof ds.version === "number" ? { version: ds.version } : {}),
      },
    },
    queried: read.address,
  };
}

function adapter(options: GrafanaObserveOptions): ObserverAdapter<GrafanaClient> {
  const providers = chantProviderNames(options.entities.values());
  const members = dashboardMembers(options.entities);
  // One read per dashboard, however many of its members are asked about.
  const dashboardOnce = (client: GrafanaClient, uid: string) => client.once(`observe:${uid}`, () => observeDashboard(client, uid, providers, options.owned));

  return {
    async bind() {
      const client = await bindGrafana({ ...options });
      // Discovery is the first request, so a refused token or an unreachable
      // server fails the bind: every entity NOT-OBSERVED with one reason.
      await dashboardApi(client);
      return client;
    },
    classifyBindFailure: (err) => classifyGrafanaFailure(err),
    async read(client, entity): Promise<EntityObservation> {
      if (entity.type === DASHBOARD_PROVIDER_TYPE) {
        return { unobserved: { reason: "unsupported-kind", detail: PROVIDER_NOT_OBSERVABLE } };
      }
      if (isDashboardPart(entity.type)) {
        const holder = members.get(entity.name);
        const dashboard = holder !== undefined ? options.entities.get(holder) : undefined;
        const uid = holder !== undefined && dashboard ? declaredUid(holder, DASHBOARD_TYPE, dashboard.props) : undefined;
        if (!uid) return { unobserved: { reason: "unsupported-kind", detail: ORPHAN_PART } };
        const verdict = await dashboardOnce(client, uid);
        if (!("present" in verdict)) return verdict;
        const { ownership, marker } = verdict.present;
        return {
          present: { type: entity.type, physicalId: uid, status: "PRESENT", ...(ownership ? { ownership } : {}), ...(marker ? { marker } : {}), attributes: { dashboard: uid } },
          ...(verdict.queried ? { queried: verdict.queried } : {}),
        };
      }
      const uid = declaredUid(entity.name, entity.type, entity.props);
      if (entity.type === DASHBOARD_TYPE) {
        return uid ? dashboardOnce(client, uid) : { unobserved: { reason: "read-failed", detail: `"${entity.name}" does not resolve to a uid` } };
      }
      if (entity.type === DATASOURCE_TYPE || entity.type === EXTERNAL_DATASOURCE_TYPE) {
        return uid ? observeDatasource(client, entity, uid, options.owned) : { unobserved: { reason: "read-failed", detail: `"${entity.name}" does not resolve to a uid` } };
      }
      return { unobserved: { reason: "unsupported-kind", detail: `no grafana reader for ${entity.type}` } };
    },
  };
}

/** Observe every declared grafana entity against the environment's Grafana. */
export async function describeResources(options: GrafanaObserveOptions): Promise<DescribeResourcesResult> {
  const declared: DeclaredEntity[] = [];
  for (const name of options.entityNames) {
    const entity = options.entities.get(name);
    if (!entity) continue;
    declared.push({ name, type: entity.entityType, props: entity.props });
  }
  return observeEntities(declared, adapter(options));
}
