/**
 * An alerting provisioning file in a canonical form, so two files Grafana
 * provisions the same way compare equal. The round-trip tests compare the
 * source (with the importer's edits applied) and the rebuilt file through
 * this.
 *
 * What it treats as equal, each from Grafana's file reader
 * (`pkg/services/provisioning/alerting/*_types.go`, v12.4.11 and v13.2.2):
 *
 * - `orgId: 1` and no `orgId` (a value below 1 reads as 1);
 * - a rule's `noDataState: NoData`, `execErrState: Alerting`, `for: 0s`,
 *   `keepFiringFor: 0s`, `isPaused: false`, `panelId: 0`, empty `labels`
 *   and `annotations`, and the same left out;
 * - a query's `queryType: ""`, and a `relativeTimeRange` of 0 to 0, and
 *   the same left out;
 * - an expression model's `datasource` of `__expr__` and a `refId` equal
 *   to the query's, and the same left out (Grafana sets both);
 * - `disableResolveMessage: false` and none;
 * - the order of rule groups, contact points, mute timings and templates,
 *   which chant writes sorted.
 */

import { EXPRESSION_DATASOURCE_UID } from "../alerting";
import { isObject } from "./normalize";

type Json = Record<string, unknown>;

function dropOrg(o: Json): Json {
  const { orgId, ...rest } = o;
  return orgId === undefined || orgId === 1 || (typeof orgId === "number" && orgId < 1) ? rest : o;
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || (isObject(v) && Object.keys(v).length === 0);
}

function query(q: Json): Json {
  const out: Json = { ...q };
  if (out.queryType === "" || out.queryType === undefined) delete out.queryType;
  const r = out.relativeTimeRange;
  if (isObject(r) && (r.from ?? 0) === 0 && (r.to ?? 0) === 0) delete out.relativeTimeRange;
  else if (isObject(r)) out.relativeTimeRange = { from: r.from ?? 0, to: r.to ?? 0 };
  if (out.datasourceUid === EXPRESSION_DATASOURCE_UID && isObject(out.model)) {
    const m: Json = { ...out.model };
    if (isObject(m.datasource) && m.datasource.uid === EXPRESSION_DATASOURCE_UID) delete m.datasource;
    if (m.refId === out.refId) delete m.refId;
    out.model = m;
  }
  return out;
}

const RULE_DEFAULTS: Json = { noDataState: "NoData", execErrState: "Alerting", for: "0s", keepFiringFor: "0s", isPaused: false, panelId: 0, dashboardUid: "" };

function rule(r: Json): Json {
  const out: Json = { ...r };
  for (const [k, v] of Object.entries(RULE_DEFAULTS)) if (out[k] === v || out[k] === null) delete out[k];
  if (out.for === "0") delete out.for;
  if (out.keepFiringFor === "0") delete out.keepFiringFor;
  for (const k of ["labels", "annotations"]) if (isEmpty(out[k])) delete out[k];
  if (Array.isArray(out.data)) out.data = out.data.map((q) => (isObject(q) ? query(q) : q));
  return out;
}

function byName(a: unknown, b: unknown): number {
  const ka = isObject(a) ? `${String(a.folder ?? "")}\u0000${String(a.name ?? "")}` : "";
  const kb = isObject(b) ? `${String(b.folder ?? "")}\u0000${String(b.name ?? "")}` : "";
  return ka.localeCompare(kb);
}

/** The file in canonical form. */
export function normalizeAlerting(file: Json): Json {
  const out: Json = {};
  if (file.apiVersion !== undefined) out.apiVersion = file.apiVersion;
  if (Array.isArray(file.groups) && file.groups.length > 0) {
    out.groups = file.groups
      .map((g) => (isObject(g) ? { ...dropOrg(g), rules: Array.isArray(g.rules) ? g.rules.map((r) => (isObject(r) ? rule(r) : r)) : g.rules } : g))
      .sort(byName);
  }
  if (Array.isArray(file.contactPoints) && file.contactPoints.length > 0) {
    out.contactPoints = file.contactPoints
      .map((c) =>
        isObject(c)
          ? {
              ...dropOrg(c),
              receivers: Array.isArray(c.receivers)
                ? c.receivers.map((r) => {
                    if (!isObject(r)) return r;
                    const { disableResolveMessage, ...rest } = r;
                    return disableResolveMessage === true ? r : rest;
                  })
                : c.receivers,
            }
          : c,
      )
      .sort(byName);
  }
  if (Array.isArray(file.policies) && file.policies.length > 0) out.policies = file.policies.map((p) => (isObject(p) ? dropOrg(p) : p));
  if (Array.isArray(file.muteTimes) && file.muteTimes.length > 0) out.muteTimes = file.muteTimes.map((m) => (isObject(m) ? dropOrg(m) : m)).sort(byName);
  if (Array.isArray(file.templates) && file.templates.length > 0) out.templates = file.templates.map((t) => (isObject(t) ? dropOrg(t) : t)).sort(byName);
  return out;
}
