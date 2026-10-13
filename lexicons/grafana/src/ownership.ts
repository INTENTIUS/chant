/**
 * Whose a live dashboard is (#2946).
 *
 * `serializer.ts` used to say Grafana had no metadata channel. It has two,
 * both on the `dashboard.grafana.app` resource and neither in the dashboard
 * JSON:
 *
 * - **`metadata.labels`**, which Grafana keeps as written for a dashboard
 *   created or updated through `/apis`. chant's marker there is the shared
 *   Kubernetes label convention, `LABEL_OWNERSHIP_KEYS`
 *   (`app.kubernetes.io/managed-by: chant` plus the stack and env labels).
 *   The API applier (#2948) stamps it with {@link grafanaOwnershipLabels};
 *   this reads it back, stack and env included.
 * - **`metadata.annotations`**, which Grafana writes itself for a
 *   file-provisioned dashboard: `grafana.app/managedBy:
 *   classic-file-provisioning` and `grafana.app/managerId: <provider name>`.
 *   The provider name is the one chant writes into
 *   `provisioning/dashboards/chant.yaml` (`chant` unless a
 *   `DashboardProvider` names another), so a dashboard whose manager is one
 *   of the project's providers is chant's. That channel carries no stack or
 *   env, so it gives a verdict and never a marker.
 *
 * Anything else a read can see (a dashboard saved in the UI, one another
 * provider or tool manages) is `foreign`.
 *
 * Two reads have no channel at all, and say `unknown` rather than guess:
 * the legacy `/api/dashboards/uid` read Grafana 11 is observed through, and
 * every datasource read (`/api/datasources` returns no labels, and the
 * `readOnly` flag says a datasource is provisioned, not by whom).
 */

import {
  LABEL_OWNERSHIP_KEYS,
  OWNERSHIP_MANAGED_BY_VALUE,
  classifyOwnership,
  hasOwnershipMarker,
  ownershipEntries,
  readOwnership,
  type ChannelKeys,
  type OwnershipMarker,
} from "@intentius/chant/ownership";
import { DASHBOARD_PROVIDER_TYPE } from "./dashboard";
import type { LiveDashboard } from "./api/dashboards";
import type { LiveFolder } from "./api/folders";

/** The label keys chant's marker uses on a `dashboard.grafana.app` resource. */
export const GRAFANA_OWNERSHIP_KEYS: ChannelKeys = LABEL_OWNERSHIP_KEYS;

export const MANAGED_BY_ANNOTATION = "grafana.app/managedBy";
export const MANAGER_ID_ANNOTATION = "grafana.app/managerId";
/** `grafana.app/managedBy` for a dashboard loaded by a file provider. */
export const FILE_PROVISIONING_MANAGER = "classic-file-provisioning";

/**
 * The provider name the build writes when a project declares none. It is
 * chant's managed-by value on purpose: it comes back from Grafana as the
 * `grafana.app/managerId` of every dashboard the provider loads.
 */
export const DEFAULT_PROVIDER_NAME = OWNERSHIP_MANAGED_BY_VALUE;

export type OwnershipVerdict = "owned" | "foreign" | "unknown";

/** The labels the API applier (#2948) writes on a dashboard it creates, for this build's stack and env. */
export function grafanaOwnershipLabels(ownership: { stack: string; env?: string }): Record<string, string> {
  return ownershipEntries(GRAFANA_OWNERSHIP_KEYS, ownership);
}

/**
 * The provider names that load this project's dashboards: every declared
 * `DashboardProvider`, or the default one the build writes when there is
 * none.
 */
export function chantProviderNames(entities: Iterable<{ entityType: string; props: Record<string, unknown> }>): Set<string> {
  const names = new Set<string>();
  for (const e of entities) {
    if (e.entityType === DASHBOARD_PROVIDER_TYPE && typeof e.props.name === "string") names.add(e.props.name);
  }
  if (names.size === 0) names.add(DEFAULT_PROVIDER_NAME);
  return names;
}

/** Why a verdict is what it is, for an `owned: true` read to put in its `filtered` detail. */
export function ownershipGap(dashboard: LiveDashboard): string {
  return dashboard.via === "legacy"
    ? "it was read over /api/dashboards/uid (Grafana 11), which returns no labels or annotations"
    : "it carries neither chant's managed-by label nor a manager annotation naming one of this project's dashboard providers";
}

/** A dashboard's ownership verdict, and the stack/env marker when its labels carry one. */
export function dashboardOwnership(
  dashboard: LiveDashboard,
  providers: ReadonlySet<string>,
): { ownership: OwnershipVerdict; marker?: OwnershipMarker } {
  if (dashboard.via === "legacy") return { ownership: "unknown" };
  if (hasOwnershipMarker(dashboard.labels, GRAFANA_OWNERSHIP_KEYS)) {
    const marker = readOwnership(dashboard.labels, GRAFANA_OWNERSHIP_KEYS);
    return { ownership: classifyOwnership(dashboard.labels, GRAFANA_OWNERSHIP_KEYS), ...(marker ? { marker } : {}) };
  }
  const manager = dashboard.annotations[MANAGER_ID_ANNOTATION];
  if (dashboard.annotations[MANAGED_BY_ANNOTATION] === FILE_PROVISIONING_MANAGER && manager !== undefined && providers.has(manager)) {
    return { ownership: "owned" };
  }
  return { ownership: "foreign" };
}

/**
 * A folder's ownership verdict, read the way a dashboard's is: chant's labels
 * (the API applier's), else the manager annotations Grafana writes on a
 * folder that file provisioning made for one of this project's providers.
 * A folder read over `/api/folders` (Grafana 11) has neither: `unknown`.
 */
export function folderOwnership(folder: LiveFolder, providers: ReadonlySet<string>): { ownership: OwnershipVerdict; marker?: OwnershipMarker } {
  if (folder.via === "legacy") return { ownership: "unknown" };
  if (hasOwnershipMarker(folder.labels, GRAFANA_OWNERSHIP_KEYS)) {
    const marker = readOwnership(folder.labels, GRAFANA_OWNERSHIP_KEYS);
    return { ownership: classifyOwnership(folder.labels, GRAFANA_OWNERSHIP_KEYS), ...(marker ? { marker } : {}) };
  }
  const annotations = folder.annotations ?? {};
  const manager = annotations[MANAGER_ID_ANNOTATION];
  if (annotations[MANAGED_BY_ANNOTATION] === FILE_PROVISIONING_MANAGER && manager !== undefined && providers.has(manager)) return { ownership: "owned" };
  return { ownership: "foreign" };
}
