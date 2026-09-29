/**
 * grafana deep observation (#2946): the property tree of each declared
 * dashboard and datasource as Grafana holds it, so a dashboard edited in the
 * UI shows up in `chant lifecycle diff --live` path by path.
 *
 * The read is the thin read's (./describe-resources.ts): same binding, same
 * discovered API, same uid. What differs is what is done with the answer.
 *
 * - A dashboard's stored JSON goes through the importer
 *   (./import/live-export.ts `dashboardTree`), which puts it into the
 *   vocabulary its declaration is written in: `graphTooltip:
 *   "sharedCrosshair"` rather than `1`, rows holding their panels, queries
 *   without the refIds the build numbered. Core then diffs that against the
 *   declaration's props, normalized on both sides by
 *   ./deep-observe-hooks.ts.
 * - A dashboard Grafana stores as v2 is read at v2 and converted to the
 *   classic JSON the importer makes of it (#2947), so the tree is
 *   diffed against the declaration: a tab added in the UI is a row that
 *   the declaration does not have.
 * - The folder is not in the JSON. It is read from the resource's folder
 *   and written as its path, its titles from the root joined with `/`, the
 *   form `Dashboard.folder` takes (a `Folder` given for it is held as its
 *   path too); when the declared path is one the build had to rewrite to
 *   make directories (` Ops / Team ` becomes `Ops/Team`), the declared
 *   spelling is kept, since the two name the same folder.
 * - A `Folder` is read by its uid: its title, and its parent's uid when it
 *   is nested. A declared `parent` is a reference, which core does not
 *   compare, so a folder moved to another parent shows as drift on the
 *   dashboards it holds, whose paths change.
 * - A datasource's API payload is put into `DatasourceProps` vocabulary,
 *   secrets as key names only.
 *
 * Tri-state, one level down: a dashboard that is not there is left out (the
 * thin read reports it missing); one that cannot be read (a failed
 * request, withheld by `owned`, a v2-stored dashboard the server cannot
 * serve at v2) is NOT-OBSERVED with its reason; a
 * provider has no API and is `unsupported-kind`. Nothing unreadable comes
 * back as a clean tree. A declared panel, row, query or variable has no tree
 * of its own (./members.ts): its properties are in its dashboard's.
 */

import type { DeepObservationResult, DeepResourceObservation, UnobservedEntity } from "@intentius/chant/lexicon";
import { deepObservation, normalizeDeepProperties } from "@intentius/chant/deep-observation";
import { boundedConcurrently, unobservedAll } from "@intentius/chant/observation";
import { bindGrafana, classifyGrafanaFailure } from "./api/bind";
import type { GrafanaClient } from "./api/client";
import { classicDashboardOf, dashboardApi, readDashboard } from "./api/dashboards";
import { liveFolderPath, readFolder } from "./api/folders";
import { FOLDER_TYPE, folderLevels, folderUidOf } from "./folder";
import { readDatasource } from "./api/datasources";
import { DASHBOARD_PROVIDER_TYPE, DASHBOARD_TYPE } from "./dashboard";
import { DATASOURCE_TYPE, EXTERNAL_DATASOURCE_TYPE } from "./datasource";
import { grafanaDeepNormalizationHooks } from "./deep-observe-hooks";
import { ORPHAN_PART, PROVIDER_NOT_OBSERVABLE, declaredUid, type GrafanaObserveOptions } from "./describe-resources";
import { dashboardMembers, isDashboardPart } from "./members";
import { dashboardTree, datasourceProps } from "./import/live-export";
import { chantProviderNames, dashboardOwnership, folderOwnership, ownershipGap } from "./ownership";

export { grafanaDeepNormalizationHooks };

type Json = Record<string, unknown>;

/** A folder path as the build writes it (build.ts `folderDir`), which is the path Grafana's folders take. */
function samePath(declared: string, live: string): boolean {
  return folderLevels(declared).join("/") === live;
}

async function dashboardProperties(client: GrafanaClient, uid: string, declared: Json, providers: ReadonlySet<string>, owned: boolean | undefined): Promise<DeepResourceObservation | UnobservedEntity | undefined> {
  const read = await readDashboard(client, uid);
  if ("absent" in read) return undefined;
  const live = read.present;
  const classic = classicDashboardOf(live);
  if ("unsupported" in classic) {
    return { type: DASHBOARD_TYPE, reason: "unsupported-kind", detail: `dashboard "${uid}" is not readable: ${classic.unsupported}`, queried: live.address };
  }
  if (owned) {
    const { ownership } = dashboardOwnership(live, providers);
    if (ownership !== "owned") {
      return { type: DASHBOARD_TYPE, reason: "filtered", detail: `dashboard "${uid}" is ${ownership === "unknown" ? "of unknown ownership" : "not chant's"}: ${ownershipGap(live)}`, queried: live.address };
    }
  }
  const { tree } = dashboardTree(classic.json);
  const folder = live.folderUid ? await liveFolderPath(client, live.folderUid) : undefined;
  if (folder !== undefined) {
    const declaredFolder = typeof declared.folder === "string" ? declared.folder : undefined;
    tree.folder = declaredFolder !== undefined && samePath(declaredFolder, folder) ? declaredFolder : folder;
  }
  return {
    type: DASHBOARD_TYPE,
    physicalId: uid,
    properties: normalizeDeepProperties(tree, { entityType: DASHBOARD_TYPE, side: "live", hooks: grafanaDeepNormalizationHooks }),
  };
}

async function folderProperties(client: GrafanaClient, uid: string, providers: ReadonlySet<string>, owned: boolean | undefined): Promise<DeepResourceObservation | UnobservedEntity | undefined> {
  const live = await readFolder(client, uid);
  if (!live) return undefined;
  if (owned) {
    const { ownership } = folderOwnership(live, providers);
    if (ownership !== "owned") {
      return { type: FOLDER_TYPE, reason: "filtered", detail: `folder "${uid}" is ${ownership === "unknown" ? "of unknown ownership (read over /api/folders, which has no labels)" : "not chant's"}`, queried: live.address };
    }
  }
  const tree: Json = { title: live.title, uid: live.uid, ...(live.parentUid ? { parent: live.parentUid } : {}) };
  return { type: FOLDER_TYPE, physicalId: uid, properties: normalizeDeepProperties(tree, { entityType: FOLDER_TYPE, side: "live", hooks: grafanaDeepNormalizationHooks }) };
}

async function datasourceProperties(client: GrafanaClient, uid: string, entityType: string, owned: boolean | undefined): Promise<DeepResourceObservation | UnobservedEntity | undefined> {
  const read = await readDatasource(client, uid);
  if ("absent" in read) return undefined;
  if (owned) {
    return { type: entityType, reason: "filtered", detail: `datasource "${uid}" exists but its ownership cannot be read: Grafana's datasource API returns no labels or annotations`, queried: read.address };
  }
  const props = datasourceProps(read.present);
  // An ExternalDatasource declares only what panels refer to it by.
  const tree = entityType === EXTERNAL_DATASOURCE_TYPE ? { type: props.type, uid: props.uid, name: props.name } : props;
  return {
    type: entityType,
    physicalId: uid,
    properties: normalizeDeepProperties(tree, { entityType, side: "live", hooks: grafanaDeepNormalizationHooks }),
  };
}

function isUnobserved(v: DeepResourceObservation | UnobservedEntity): v is UnobservedEntity {
  return "reason" in v;
}

/** Read the live property tree of every declared grafana entity. */
export async function observeResourcesDeepGrafana(options: GrafanaObserveOptions): Promise<DeepObservationResult> {
  let client: GrafanaClient;
  try {
    client = await bindGrafana({ ...options });
    await dashboardApi(client);
  } catch (err) {
    const { reason, detail } = classifyGrafanaFailure(err);
    return deepObservation({}, unobservedAll(options.entities.keys(), reason, detail, options.entities));
  }

  const providers = chantProviderNames(options.entities.values());
  const members = dashboardMembers(options.entities);
  const resources: Record<string, DeepResourceObservation> = {};
  const unobserved: Record<string, UnobservedEntity> = {};

  await boundedConcurrently([...options.entities], async ([name, { entityType, props }]) => {
    if (entityType === DASHBOARD_PROVIDER_TYPE) {
      unobserved[name] = { type: entityType, reason: "unsupported-kind", detail: PROVIDER_NOT_OBSERVABLE };
      return;
    }
    // A panel, row, query or variable is compared as part of its
    // dashboard's tree, so it has no tree of its own: in neither map, which
    // the deep diff reads as nothing to compare (helm does the same for its
    // chart-authoring entities). One on no dashboard cannot be observed.
    if (isDashboardPart(entityType)) {
      if (!members.has(name)) unobserved[name] = { type: entityType, reason: "unsupported-kind", detail: ORPHAN_PART };
      return;
    }
    const isDashboard = entityType === DASHBOARD_TYPE;
    const isFolder = entityType === FOLDER_TYPE;
    const isDatasource = entityType === DATASOURCE_TYPE || entityType === EXTERNAL_DATASOURCE_TYPE;
    if (!isDashboard && !isDatasource && !isFolder) {
      unobserved[name] = { type: entityType, reason: "unsupported-kind", detail: `no grafana deep reader for ${entityType}` };
      return;
    }
    const uid = declaredUid(name, entityType, props);
    if (!uid) {
      unobserved[name] = { type: entityType, reason: "read-failed", detail: `"${name}" does not resolve to a uid` };
      return;
    }
    try {
      const result = isDashboard
        ? await dashboardProperties(client, uid, props, providers, options.owned)
        : isFolder
          ? await folderProperties(client, uid, providers, options.owned)
          : await datasourceProperties(client, uid, entityType, options.owned);
      // Not there: the thin read reports it missing; restating it as a property hole would say it twice.
      if (result === undefined) return;
      if (isUnobserved(result)) unobserved[name] = result;
      else resources[name] = result;
    } catch (err) {
      // A partial read never comes back as a clean tree.
      const { reason, detail } = classifyGrafanaFailure(err);
      unobserved[name] = { type: entityType, reason, detail };
    }
  });

  return deepObservation(resources, unobserved);
}
