/**
 * An alerting provisioning file -> a `Plan`, for `chant import`.
 *
 * Accepts what Grafana's file provisioner reads and what
 * `GET /api/v1/provisioning/*\/export` writes (the same format at v12.4.11
 * and v13.2.2): rule groups, contact points, notification policies, mute
 * timings and templates, in one file or split across several.
 *
 * - A rule group becomes an `AlertRuleGroup`, each rule an `AlertRule`,
 *   each entry of a rule's `data` a declaration of its own: a server-side
 *   expression as its typed class (`ReduceExpression`, `ThresholdExpression`,
 *   ...), and a datasource query as an `AlertQuery` holding its model as it
 *   is, so nothing a plugin stores is lost.
 * - A datasource uid a query names becomes an `ExternalDatasource` when the
 *   file says its plugin type (`model.datasource.type`), so the checks can
 *   see it (GRAF108 parses Prometheus queries). When the type has to be
 *   inferred from the model, the import says so; when it cannot be told,
 *   the query keeps the bare uid and the import says that too.
 * - A contact point, policy, mute timing or template becomes its class;
 *   a receiver or timing named in the same file is referenced by variable.
 * - `deleteRules`, `deleteContactPoints`, `resetPolicies`, `deleteMuteTimes`
 *   and `deleteTemplates` are not carried, with a warning.
 *
 * Grafana's editor writes keys into expression models that the expression
 * does not read (a `conditions` block on reduce and math, `operator`,
 * `query`, `reducer` and `type` in a threshold's conditions, `type` in
 * classic conditions). They are left out as edits without a warning:
 * Grafana evaluates the rule the same without them.
 */

import { pointer, type ImportEdit } from "./edits";
import { NO_PROP, Report } from "./report";
import { declRef, type Declaration, type DeclRef, type Plan } from "./model";
import { isObject, refIdAt } from "./normalize";
import { DEFAULT_RELATIVE_TIME_RANGE } from "../alerting-build";
import { EXPRESSION_DATASOURCE_UID, type ExpressionKind } from "../alerting";
import { validateExpressionSchema } from "../schema-validate";
import { REDACTED, secretSettings } from "../contact-point-secrets";

type Json = Record<string, unknown>;

const EXPRESSION_CLASS: Record<ExpressionKind, string> = {
  reduce: "ReduceExpression",
  math: "MathExpression",
  threshold: "ThresholdExpression",
  resample: "ResampleExpression",
  classic_conditions: "ClassicConditionsExpression",
  sql: "SqlExpression",
};

/** Keys every expression model may hold (the pinned `expr` schema's common fields). */
const EXPRESSION_COMMON = ["hide", "intervalMs", "maxDataPoints", "queryType", "resultAssertions", "timeRange"];

/** Keys each expression type reads, from the pinned `expr` schema. */
const EXPRESSION_KEYS: Record<ExpressionKind, string[]> = {
  math: ["expression"],
  reduce: ["expression", "reducer", "settings"],
  resample: ["expression", "window", "downsampler", "upsampler"],
  classic_conditions: ["conditions"],
  threshold: ["expression", "conditions"],
  sql: ["expression", "format"],
};

/**
 * Keys of a condition each command reads: the threshold command
 * (`pkg/expr/threshold.go`) and classic conditions (`ConditionJSON` in
 * `pkg/expr/classic`). The editor writes more (`operator`, `query` and
 * `reducer` on a threshold, `type: query` on both).
 */
const CONDITION_KEYS: Partial<Record<ExpressionKind, string[]>> = {
  threshold: ["evaluator", "unloadEvaluator", "loadedDimensions", "loadedFingerprints"],
  classic_conditions: ["evaluator", "operator", "query", "reducer"],
};

function conditionsKept(kind: ExpressionKind, conditions: unknown[]): unknown[] {
  const keys = CONDITION_KEYS[kind]!;
  return conditions.map((c) => (isObject(c) ? Object.fromEntries(Object.entries(c).filter(([k]) => keys.includes(k))) : c));
}

const RULE_FIELDS = [
  "uid",
  "title",
  "condition",
  "data",
  "dashboardUid",
  "dasboardUid",
  "panelId",
  "noDataState",
  "execErrState",
  "for",
  "keepFiringFor",
  "missing_series_evals_to_resolve",
  "annotations",
  "labels",
  "isPaused",
  "notification_settings",
  "record",
];

const GROUP_FIELDS = ["orgId", "name", "folder", "interval", "rules"];
const NOTIFICATION_SETTINGS_FIELDS = ["receiver", "group_by", "group_wait", "group_interval", "repeat_interval", "mute_time_intervals", "active_time_intervals"];
const ROUTE_FIELDS = [
  "receiver",
  "group_by",
  "object_matchers",
  "matchers",
  "match",
  "match_re",
  "continue",
  "group_wait",
  "group_interval",
  "repeat_interval",
  "mute_time_intervals",
  "active_time_intervals",
  "routes",
];
const DELETIONS: Record<string, string> = {
  deleteRules: "rule deletions",
  deleteContactPoints: "contact point deletions",
  resetPolicies: "policy resets",
  deleteMuteTimes: "mute timing deletions",
  deleteTemplates: "template deletions",
};

function isExpressionKind(v: unknown): v is ExpressionKind {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(EXPRESSION_CLASS, v);
}

/** A datasource's plugin type as far as one query shows it: stated in the model, or inferred from its keys. */
function pluginTypeOf(model: Json, queryType: unknown): { type: string; inferred: boolean } | undefined {
  const ds = model.datasource;
  if (isObject(ds) && typeof ds.type === "string" && ds.type !== "" && ds.type !== EXPRESSION_DATASOURCE_UID) return { type: ds.type, inferred: false };
  // Prometheus: PromQL in `expr` with the editor's `instant`/`range` switches, and no Loki `queryType`.
  if (typeof model.expr === "string" && (typeof model.instant === "boolean" || typeof model.range === "boolean") && model.queryType === undefined && !queryType) {
    return { type: "prometheus", inferred: true };
  }
  return undefined;
}

class AlertingConverter {
  readonly declarations: Declaration[] = [];
  private readonly datasources = new Map<string, { id: string; type: string; inferred: boolean }>();
  private readonly untyped = new Set<string>();
  private readonly contactPoints = new Map<string, string>();
  private readonly timings = new Map<string, string>();

  constructor(
    private readonly doc: Json,
    private readonly report: Report,
  ) {}

  private receiverRef(name: unknown): unknown {
    return typeof name === "string" && this.contactPoints.has(name) ? declRef(this.contactPoints.get(name)!) : name;
  }

  private timingRefs(list: unknown): unknown {
    return Array.isArray(list) ? list.map((n) => (typeof n === "string" && this.timings.has(n) ? declRef(this.timings.get(n)!) : n)) : list;
  }

  /** Scan every query for the datasources it names, and declare the ones whose type is known. */
  private scanDatasources(groups: unknown[]): void {
    const found = new Map<string, { type?: string; inferred: boolean }>();
    for (const g of groups) {
      for (const r of isObject(g) && Array.isArray(g.rules) ? g.rules : []) {
        for (const q of isObject(r) && Array.isArray(r.data) ? r.data : []) {
          if (!isObject(q) || typeof q.datasourceUid !== "string" || q.datasourceUid === EXPRESSION_DATASOURCE_UID) continue;
          const t = pluginTypeOf(isObject(q.model) ? q.model : {}, q.queryType);
          const prev = found.get(q.datasourceUid);
          if (!prev?.type || (prev.inferred && t && !t.inferred)) found.set(q.datasourceUid, { type: t?.type, inferred: t?.inferred ?? false });
        }
      }
    }
    for (const [uid, t] of [...found].sort(([a], [b]) => a.localeCompare(b))) {
      if (!t.type) {
        this.untyped.add(uid);
        continue;
      }
      const id = `datasource:${uid}`;
      this.datasources.set(uid, { id, type: t.type, inferred: t.inferred });
      this.declarations.push({ id, kind: "new", className: "ExternalDatasource", props: { type: t.type, uid }, name: uid, module: "datasources" });
    }
    const inferred = [...this.datasources].filter(([, d]) => d.inferred).map(([uid]) => `"${uid}"`);
    if (inferred.length > 0) {
      this.report.warn(
        `datasources: the file does not say the plugin type of ${inferred.join(", ")}; the queries look like PromQL, so ${inferred.length === 1 ? "it is" : "they are"} declared as a prometheus ExternalDatasource. Change the type if that is wrong.`,
      );
    }
    if (this.untyped.size > 0) {
      const uids = [...this.untyped].map((u) => `"${u}"`).join(", ");
      this.report.warn(
        `datasources: the file does not say the plugin type of ${uids}, so the queries name ${this.untyped.size === 1 ? "it" : "them"} by uid alone and the checks cannot see what ${this.untyped.size === 1 ? "it is" : "they are"}. Declare an ExternalDatasource with its type and pass it as the query's datasource.`,
      );
    }
  }

  private templates(list: unknown[]): void {
    list.forEach((t, i) => {
      if (!isObject(t) || typeof t.name !== "string" || typeof t.template !== "string") {
        this.report.drop(pointer("templates", i), "templates", `entry ${i}`, "(it has no name or template)");
        return;
      }
      const props: Json = { name: t.name, ...(t.orgId !== undefined ? { orgId: t.orgId } : {}), template: t.template };
      for (const k of Object.keys(t)) if (!["name", "orgId", "template"].includes(k)) this.report.drop(pointer("templates", i, k), `template "${t.name}"`, k, NO_PROP);
      this.declarations.push({ id: `template:${i}`, kind: "new", className: "NotificationTemplate", props, name: `${t.name} template`, module: "notifications" });
    });
  }

  private muteTimes(list: unknown[]): void {
    list.forEach((t, i) => {
      if (!isObject(t) || typeof t.name !== "string") {
        this.report.drop(pointer("muteTimes", i), "muteTimes", `entry ${i}`, "(it has no name)");
        return;
      }
      const id = `mute:${i}`;
      this.timings.set(t.name, id);
      const props: Json = { name: t.name, ...(t.orgId !== undefined ? { orgId: t.orgId } : {}), time_intervals: Array.isArray(t.time_intervals) ? t.time_intervals : [] };
      for (const k of Object.keys(t)) if (!["name", "orgId", "time_intervals"].includes(k)) this.report.drop(pointer("muteTimes", i, k), `mute timing "${t.name}"`, k, NO_PROP);
      this.declarations.push({ id, kind: "new", className: "MuteTiming", props, name: `${t.name} mute timing`, module: "notifications" });
    });
  }

  private contactPointList(list: unknown[]): void {
    list.forEach((cp, i) => {
      if (!isObject(cp) || typeof cp.name !== "string") {
        this.report.drop(pointer("contactPoints", i), "contactPoints", `entry ${i}`, "(it has no name)");
        return;
      }
      const id = `contact-point:${i}`;
      this.contactPoints.set(cp.name, id);
      const subject = `contact point "${cp.name}"`;
      const receivers = (Array.isArray(cp.receivers) ? cp.receivers : []).flatMap((r, j) => {
        if (!isObject(r) || typeof r.type !== "string") {
          this.report.drop(pointer("contactPoints", i, "receivers", j), subject, `receivers[${j}]`, "(it has no type)");
          return [];
        }
        const out: Json = {};
        for (const k of ["uid", "type", "settings", "disableResolveMessage"]) if (r[k] !== undefined && r[k] !== null) out[k] = r[k];
        if (out.settings === undefined) out.settings = {};
        if (isObject(out.settings)) out.settings = this.redacted(out.settings, r.type as string, cp.name as string, ["contactPoints", i, "receivers", j, "settings"]);
        for (const k of Object.keys(r)) {
          if (!["uid", "type", "settings", "disableResolveMessage"].includes(k)) this.report.drop(pointer("contactPoints", i, "receivers", j, k), subject, k, NO_PROP);
        }
        return [out];
      });
      for (const k of Object.keys(cp)) if (!["name", "orgId", "receivers"].includes(k)) this.report.drop(pointer("contactPoints", i, k), subject, k, NO_PROP);
      const props: Json = { name: cp.name, ...(cp.orgId !== undefined ? { orgId: cp.orgId } : {}), receivers };
      this.declarations.push({ id, kind: "new", className: "ContactPoint", props, name: `${cp.name} contact point`, module: "notifications" });
    });
  }

  /**
   * An export made without secrets writes `[REDACTED]` for each; provisioning
   * that would send the literal text. Each becomes `$__env{NAME}`, named from
   * the contact point, integration and setting, with a warning.
   */
  private redacted(settings: Json, type: string, name: string, path: Array<string | number>): Json {
    const out = structuredClone(settings);
    const names: string[] = [];
    for (const [key, value] of secretSettings(type, settings)) {
      if (value !== REDACTED) continue;
      const env = `${name} ${type} ${key}`.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
      const segments = key.split(".");
      let node = out;
      for (const seg of segments.slice(0, -1)) node = node[seg] as Json;
      node[segments[segments.length - 1]] = `$__env{${env}}`;
      this.report.edit({ op: "replace", path: pointer(...path, ...segments), value: `$__env{${env}}` });
      names.push(`${key} as $__env{${env}}`);
    }
    if (names.length > 0) {
      this.report.warn(`contact point "${name}" (${type}): the file was exported without secrets, so ${names.join(" and ")} ${names.length === 1 ? "is" : "are"} read from the environment; set ${names.length === 1 ? "it" : "them"} where Grafana runs`);
    }
    return out;
  }

  private route(r: Json, path: Array<string | number>, subject: string): Json {
    const out: Json = {};
    for (const k of ROUTE_FIELDS) {
      const v = r[k];
      if (v === undefined || v === null) continue;
      if (k === "receiver") out.receiver = this.receiverRef(v);
      else if (k === "mute_time_intervals" || k === "active_time_intervals") out[k] = this.timingRefs(v);
      else if (k === "routes" && Array.isArray(v)) out.routes = v.map((c, i) => (isObject(c) ? this.route(c, [...path, "routes", i], subject) : c));
      else out[k] = v;
    }
    for (const k of Object.keys(r)) if (!ROUTE_FIELDS.includes(k) && k !== "orgId") this.report.drop(pointer(...path, k), subject, k, NO_PROP);
    return out;
  }

  private policies(list: unknown[]): void {
    list.forEach((p, i) => {
      if (!isObject(p) || typeof p.receiver !== "string") {
        this.report.drop(pointer("policies", i), "policies", `entry ${i}`, "(the root policy has no receiver)");
        return;
      }
      const subject = "the notification policy tree";
      const route = this.route(p, ["policies", i], subject);
      for (const k of ["object_matchers", "matchers", "match", "match_re", "continue"]) {
        if (route[k] !== undefined) {
          this.report.drop(pointer("policies", i, k), subject, k, "(the root policy matches every alert)");
          delete route[k];
        }
      }
      const props: Json = { ...(p.orgId !== undefined ? { orgId: p.orgId } : {}), ...route };
      const org = typeof p.orgId === "number" && p.orgId !== 1 ? ` org ${p.orgId}` : "";
      this.declarations.push({ id: `policy:${i}`, kind: "new", className: "NotificationPolicy", props, name: `notification policy${org}`, module: "notifications" });
    });
  }

  /** True when the model, less the keys the editor writes and the expression ignores, is valid for its typed class. */
  private fitsSchema(model: Json, kind: ExpressionKind, vestigial: string[]): boolean {
    const m: Json = { ...model };
    for (const k of [...vestigial, "datasource", "refId"]) delete m[k];
    if (CONDITION_KEYS[kind] && Array.isArray(m.conditions)) m.conditions = conditionsKept(kind, m.conditions);
    return validateExpressionSchema(m).length === 0;
  }

  /** One entry of a rule's `data`: its declaration's class and props. */
  private query(q: Json, path: Array<string | number>, index: number, subject: string): { className: string; props: Json } {
    const model = isObject(q.model) ? q.model : {};
    const refId = typeof q.refId === "string" ? q.refId : refIdAt(index);
    const range = isObject(q.relativeTimeRange) ? q.relativeTimeRange : undefined;
    for (const k of Object.keys(q)) {
      if (!["refId", "queryType", "relativeTimeRange", "datasourceUid", "model"].includes(k)) this.report.drop(pointer(...path, k), subject, k, NO_PROP);
    }

    if (q.datasourceUid === EXPRESSION_DATASOURCE_UID && isExpressionKind(model.type) && (q.queryType === undefined || q.queryType === "")) {
      const kind = model.type;
      const allowed = new Set([...EXPRESSION_COMMON, ...EXPRESSION_KEYS[kind], "type", "datasource", "refId"]);
      const vestigial = kind !== "classic_conditions" && kind !== "threshold" ? ["conditions"] : [];
      const unknown = Object.keys(model).filter((k) => !allowed.has(k) && !vestigial.includes(k));
      const ds = model.datasource;
      const dsIsExpr = ds === undefined || (isObject(ds) && ds.uid === EXPRESSION_DATASOURCE_UID && Object.keys(ds).every((k) => k === "type" || k === "uid"));
      if (unknown.length === 0 && dsIsExpr && this.fitsSchema(model, kind, vestigial)) {
        const props: Json = {};
        if (refId !== refIdAt(index)) props.refId = refId;
        if (range && (range.from !== 0 || (range.to !== undefined && range.to !== 0))) props.relativeTimeRange = range;
        for (const [k, v] of Object.entries(model)) {
          if (k === "type" || k === "datasource" || k === "refId") continue;
          if (vestigial.includes(k)) {
            this.report.drop(pointer(...path, "model", k), subject, k);
            continue;
          }
          if (k === "conditions" && CONDITION_KEYS[kind] && Array.isArray(v)) {
            v.forEach((c, ci) => {
              if (!isObject(c)) return;
              for (const ck of Object.keys(c)) if (!CONDITION_KEYS[kind]!.includes(ck)) this.report.drop(pointer(...path, "model", "conditions", ci, ck), subject, ck);
            });
            props.conditions = conditionsKept(kind, v);
            continue;
          }
          props[k] = v;
        }
        return { className: EXPRESSION_CLASS[kind], props };
      }
    }

    // A datasource query, or an expression the typed classes cannot hold: its model as it is.
    const uid = typeof q.datasourceUid === "string" ? q.datasourceUid : undefined;
    const props: Json = {};
    if (uid !== undefined) props.datasource = this.datasources.has(uid) ? declRef(this.datasources.get(uid)!.id) : uid;
    props.model = model;
    if (refId !== refIdAt(index)) props.refId = refId;
    if (typeof q.queryType === "string" && q.queryType !== "") props.queryType = q.queryType;
    const from = range?.from ?? 0;
    const to = range?.to ?? 0;
    if (from !== DEFAULT_RELATIVE_TIME_RANGE.from || to !== DEFAULT_RELATIVE_TIME_RANGE.to) props.relativeTimeRange = to === 0 ? { from } : { from, to };
    return { className: "AlertQuery", props };
  }

  private rule(r: Json, gi: number, ri: number, unit: string): DeclRef | undefined {
    const path: Array<string | number> = ["groups", gi, "rules", ri];
    if (typeof r.title !== "string" || !Array.isArray(r.data)) {
      this.report.drop(pointer(...path), `group ${gi}`, `rules[${ri}]`, "(it has no title or data)");
      return undefined;
    }
    const subject = `alert rule "${r.title}"`;
    const id = `rule:${gi}:${ri}`;
    const data: DeclRef[] = [];
    r.data.forEach((q, qi) => {
      if (!isObject(q)) {
        this.report.drop(pointer(...path, "data", qi), subject, `data[${qi}]`, "(it is not a query)");
        return;
      }
      const { className, props } = this.query(q, [...path, "data", qi], qi, subject);
      const qid = `${id}:${qi}`;
      const refId = typeof q.refId === "string" ? q.refId : refIdAt(qi);
      this.declarations.push({ id: qid, kind: "new", className, props, name: { of: id, suffix: refId }, module: "rules", unit });
      data.push(declRef(qid));
    });

    const props: Json = { title: r.title };
    if (typeof r.uid === "string") props.uid = r.uid;
    const lastRef = (() => {
      const last = r.data[r.data.length - 1];
      return isObject(last) && typeof last.refId === "string" ? last.refId : refIdAt(r.data.length - 1);
    })();
    const isRecord = isObject(r.record);
    if (typeof r.condition === "string" && r.condition !== "" && (isRecord || r.condition !== lastRef)) props.condition = r.condition;
    props.data = data;
    for (const k of RULE_FIELDS) {
      if (["uid", "title", "condition", "data"].includes(k)) continue;
      const v = r[k];
      if (v === undefined || v === null) continue;
      if (k === "dasboardUid") {
        if (r.dashboardUid === undefined || r.dashboardUid === "") {
          // Grafana reads the old misspelling as dashboardUid.
          props.dashboardUid = v;
          this.report.edit({ op: "replace", path: pointer(...path, "dashboardUid"), value: v });
          this.report.drop(pointer(...path, k), subject, k);
        } else this.report.drop(pointer(...path, k), subject, k, "(dashboardUid is set too, and Grafana uses that)");
        continue;
      }
      if (k === "notification_settings" && isObject(v)) {
        const ns: Json = {};
        for (const [nk, nv] of Object.entries(v)) {
          if (!NOTIFICATION_SETTINGS_FIELDS.includes(nk)) {
            this.report.drop(pointer(...path, k, nk), subject, `notification_settings.${nk}`, NO_PROP);
            continue;
          }
          ns[nk] = nk === "receiver" ? this.receiverRef(nv) : nk.endsWith("time_intervals") ? this.timingRefs(nv) : nv;
        }
        props.notification_settings = ns;
        continue;
      }
      props[k] = v;
    }
    for (const k of Object.keys(r)) if (!RULE_FIELDS.includes(k)) this.report.drop(pointer(...path, k), subject, k, NO_PROP);
    this.declarations.push({ id, kind: "new", className: "AlertRule", props, name: r.title, module: "rules", unit });
    return declRef(id);
  }

  private groups(list: unknown[]): void {
    list.forEach((g, gi) => {
      if (!isObject(g) || typeof g.name !== "string" || typeof g.folder !== "string") {
        this.report.drop(pointer("groups", gi), "groups", `entry ${gi}`, "(it has no name or folder)");
        return;
      }
      const unit = `group:${gi}`;
      const rules = (Array.isArray(g.rules) ? g.rules : []).flatMap((r, ri) => {
        const ref = isObject(r) ? this.rule(r, gi, ri, unit) : undefined;
        return ref ? [ref] : [];
      });
      const props: Json = {};
      for (const k of GROUP_FIELDS) if (k !== "rules" && g[k] !== undefined && g[k] !== null) props[k] = g[k];
      props.rules = rules;
      for (const k of Object.keys(g)) if (!GROUP_FIELDS.includes(k)) this.report.drop(pointer("groups", gi, k), `rule group "${g.name}"`, k, NO_PROP);
      this.declarations.push({ id: unit, kind: "new", className: "AlertRuleGroup", props, name: `${g.name} rules`, module: "rules", unit });
    });
  }

  convert(): Plan {
    const d = this.doc;
    const groups = Array.isArray(d.groups) ? d.groups : [];
    this.scanDatasources(groups);
    this.templates(Array.isArray(d.templates) ? d.templates : []);
    this.muteTimes(Array.isArray(d.muteTimes) ? d.muteTimes : []);
    this.contactPointList(Array.isArray(d.contactPoints) ? d.contactPoints : []);
    this.policies(Array.isArray(d.policies) ? d.policies : []);
    this.groups(groups);
    for (const [key, what] of Object.entries(DELETIONS)) {
      const v = d[key];
      if (!Array.isArray(v) || v.length === 0) continue;
      this.report.drop(pointer(key), "the provisioning file", "", `lists ${v.length} ${what} (${key}), which chant does not write; apply them to Grafana once by hand or keep that file as it is`);
    }
    const exported = this.declarations.filter((x) => ["AlertRuleGroup", "ContactPoint", "NotificationPolicy", "MuteTiming", "NotificationTemplate"].includes(x.className ?? ""));
    return {
      directory: "",
      modules: [
        { key: "datasources", file: "alerting-datasources", summary: "Datasources the alert rules query, already in Grafana" },
        { key: "notifications", file: "notifications", summary: "Contact points, notification policies, mute timings and templates, from a Grafana alerting provisioning file" },
        { key: "rules", file: "alert-rules", summary: "Grafana-managed alert rules, from a Grafana alerting provisioning file" },
      ],
      declarations: this.declarations,
      customClasses: [],
      exports: exported.map((x) => x.id),
    };
  }
}

/** Plan an alerting provisioning file. `edits` applied to the file give what the rebuilt file should equal (see `normalizeAlerting`). */
export function planAlertingProvisioning(doc: Json): { plan: Plan; edits: ImportEdit[]; warnings: string[] } {
  const report = new Report();
  const plan = new AlertingConverter(doc, report).convert();
  return { plan, edits: report.edits, warnings: report.warnings() };
}
