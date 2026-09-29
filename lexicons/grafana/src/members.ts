/**
 * Which dashboard holds a declared panel, row, query or variable (#2946).
 *
 * Panels, rows, queries and variables are property-kind declarables: they
 * exist in Grafana only inside a dashboard's JSON. Core's live diff still
 * hands every exported declarable to `describeResources`, so a project that
 * exports its panels (as every example and every imported dashboard does)
 * asks the reader about each one. Answering "absent" would make `lifecycle
 * plan` propose creating it, and "not observed" would report a hole for every
 * panel of a dashboard that was read in full. The honest answer is the
 * dashboard's own verdict: a panel is there when the dashboard holding it is
 * there, and its properties are compared as part of that dashboard's tree.
 *
 * Membership is by identity: a dashboard's props hold the very declarable
 * objects, so the member is found by walking them, whatever nests it (a row's
 * panels, a panel's queries, a `repeat` or `datasource` variable).
 */

import { DASHBOARD_TYPE } from "./dashboard";
import { PANEL_TYPE_PREFIX, ROW_TYPE } from "./panels";
import { QUERY_TYPE_PREFIX } from "./query";
import { VARIABLE_TYPE_PREFIX } from "./variables";

type Entities = Map<string, { entityType: string; props: Record<string, unknown> }>;

function isPropertyDeclarable(v: unknown): v is { kind: "property"; props: Record<string, unknown> } {
  return typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === "property" && typeof (v as { props?: unknown }).props === "object";
}

function collect(value: unknown, into: Set<object>, seen: Set<object>): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  if (isPropertyDeclarable(value)) {
    into.add(value.props);
    collect(value.props, into, seen);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collect(v, into, seen);
    return;
  }
  if (Object.getPrototypeOf(value) === Object.prototype) {
    for (const v of Object.values(value)) collect(v, into, seen);
  }
}

/** Member entity name -> the name of the first declared dashboard holding it. Dashboards and datasources are not members. */
export function dashboardMembers(entities: Entities): Map<string, string> {
  const held = new Map<object, string>();
  for (const [name, e] of entities) {
    if (e.entityType !== DASHBOARD_TYPE) continue;
    const props = new Set<object>();
    collect(e.props, props, new Set());
    for (const p of props) if (!held.has(p)) held.set(p, name);
  }
  const out = new Map<string, string>();
  for (const [name, e] of entities) {
    if (e.entityType === DASHBOARD_TYPE) continue;
    const dashboard = held.get(e.props);
    if (dashboard !== undefined) out.set(name, dashboard);
  }
  return out;
}

/** Entity types that only ever live inside a dashboard. */
export function isDashboardPart(entityType: string): boolean {
  return entityType === ROW_TYPE || [PANEL_TYPE_PREFIX, QUERY_TYPE_PREFIX, VARIABLE_TYPE_PREFIX].some((p) => entityType.startsWith(p));
}
