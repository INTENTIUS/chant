/**
 * Grafana Operator alerting resources embedded in a k8s manifest, for
 * `chant import` (#3538).
 *
 * `GrafanaOperatorResources` (#3156) writes `GrafanaAlertRuleGroup`,
 * `GrafanaContactPoint`, `GrafanaNotificationPolicy` (with, for
 * `policyRoutes`, a `GrafanaNotificationPolicyRoute` per child route),
 * `GrafanaMuteTiming` and
 * `GrafanaNotificationTemplate` from grafana alerting declarations. The k8s
 * parser offers the one field of each that holds the alerting content
 * (`spec.rules`, `spec.receivers`, `spec.route`, `spec.time_intervals`,
 * `spec.template`) with the whole `spec` as the document. This importer
 * reads that spec back into the provisioning-file shape, which the alerting
 * importer turns into declarations, and the k8s value becomes a call of the
 * matching function in `@intentius/chant-lexicon-grafana/k8s` over the
 * declaration, so a build gives the same field again.
 *
 * The reverse of what `GrafanaOperatorResources` writes:
 *
 * - a rule: the CRD's camel case (`missingSeriesEvalsToResolve`,
 *   `notificationSettings`) goes back to the file's snake case, the
 *   `__dashboardUid__` and `__panelId__` annotations go back to
 *   `dashboardUid` and `panelId`, and the values the CRD requires and the
 *   file leaves to Grafana's defaults (`for: 0s`, `noDataState: NoData`,
 *   `execErrState: Alerting`) are left out;
 * - a receiver: each `valuesFrom` entry becomes `${NAME}` at its
 *   `targetPath` in the settings, `NAME` being the Secret key. The Secret's
 *   name is not part of a declaration, so a contact point that reads a
 *   Secret is written with a small module holding
 *   `operatorReceivers(contactPoint, "<secret>")`;
 * - a `GrafanaNotificationPolicyRoute`: its whole `spec` is the route, read
 *   as the one child of a policy that has its receiver, and written back by
 *   `operatorRouteSpec`;
 * - the policy tree: `object_matchers` go back to Alertmanager `matchers`
 *   strings where each can be written as one.
 *
 * A rule group's folder is a title in a declaration and a `GrafanaFolder`
 * name (`folderRef`) in the resource, and the resource does not hold the
 * title, so the declaration's `folder` is the reference, with a warning.
 */

import type { EmbeddedContent, EmbeddedContentImporter, EmbeddedImport } from "@intentius/chant/import/embedded";
import { planAlertingProvisioning } from "./alerting";
import { generatePlanModules } from "./generator";
import { isObject } from "./normalize";

type Json = Record<string, unknown>;

const K8S_ENTRY = "@intentius/chant-lexicon-grafana/k8s";

/** The resource types this importer reads, the spec field the k8s parser offers for each, the class it becomes and the function that writes the field back. */
const KINDS: Record<string, { select: string; className: string; through: string }> = {
  "K8s::Grafana::GrafanaAlertRuleGroup": { select: "rules", className: "AlertRuleGroup", through: "operatorRules" },
  "K8s::Grafana::GrafanaContactPoint": { select: "receivers", className: "ContactPoint", through: "operatorReceivers" },
  "K8s::Grafana::GrafanaNotificationPolicy": { select: "route", className: "NotificationPolicy", through: "operatorPolicy" },
  "K8s::Grafana::GrafanaNotificationPolicyRoute": { select: "route", className: "NotificationPolicy", through: "operatorRouteSpec" },
  "K8s::Grafana::GrafanaMuteTiming": { select: "time_intervals", className: "MuteTiming", through: "operatorTimeIntervals" },
  "K8s::Grafana::GrafanaNotificationTemplate": { select: "template", className: "NotificationTemplate", through: "operatorTemplate" },
};

/** A Secret key a `${NAME}` reference can name. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ── the reverse mapping ──────────────────────────────────────────────

/** One entry of `GrafanaAlertRuleGroup.spec.rules` as a rule of the provisioning file. */
export function provisionedRule(rule: Json): Json {
  const { missingSeriesEvalsToResolve, notificationSettings, annotations, for: forDuration, noDataState, execErrState, condition, ...rest } = rule;
  const out: Json = { ...rest };

  const record = isObject(rule.record) ? rule.record : undefined;
  if (condition !== undefined && !(record && condition === record.from)) out.condition = condition;
  if (forDuration !== undefined && forDuration !== "0s") out.for = forDuration;
  if (noDataState !== undefined && noDataState !== "NoData") out.noDataState = noDataState;
  if (execErrState !== undefined && execErrState !== "Alerting") out.execErrState = execErrState;
  if (missingSeriesEvalsToResolve !== undefined) out.missing_series_evals_to_resolve = missingSeriesEvalsToResolve;
  if (notificationSettings !== undefined) out.notification_settings = notificationSettings;

  if (isObject(annotations)) {
    const { __dashboardUid__, __panelId__, ...notes } = annotations;
    const kept: Json = { ...notes };
    if (typeof __dashboardUid__ === "string") out.dashboardUid = __dashboardUid__;
    else if (__dashboardUid__ !== undefined) kept.__dashboardUid__ = __dashboardUid__;
    if (typeof __panelId__ === "string" && /^\d+$/.test(__panelId__)) out.panelId = Number(__panelId__);
    else if (__panelId__ !== undefined) kept.__panelId__ = __panelId__;
    if (Object.keys(kept).length > 0) out.annotations = kept;
  } else if (annotations !== undefined) {
    out.annotations = annotations;
  }
  return out;
}

function setPath(settings: Json, path: string[], value: string, where: string): void {
  let node = settings;
  for (const seg of path.slice(0, -1)) {
    if (node[seg] === undefined) node[seg] = {};
    if (!isObject(node[seg])) throw new Error(`${where}: valuesFrom targetPath ${path.join(".")} goes through ${seg}, which is not an object`);
    node = node[seg] as Json;
  }
  node[path[path.length - 1]] = value;
}

/**
 * `GrafanaContactPoint.spec.receivers` as the provisioning file's receivers,
 * each `valuesFrom` entry put back as `${NAME}` in the settings, and the name
 * of the Secret they read (one Secret, as `GrafanaOperatorResources` writes).
 */
export function provisionedReceivers(receivers: unknown[], where: string): { receivers: Json[]; secretName?: string } {
  const secrets = new Set<string>();
  const out = receivers.map((r, i) => {
    if (!isObject(r)) throw new Error(`${where}: receivers[${i}] is not an object`);
    const { valuesFrom, ...rest } = r;
    const settings: Json = isObject(rest.settings) ? structuredClone(rest.settings) : {};
    for (const entry of Array.isArray(valuesFrom) ? valuesFrom : []) {
      const ref = isObject(entry) && isObject(entry.valueFrom) && isObject(entry.valueFrom.secretKeyRef) ? entry.valueFrom.secretKeyRef : undefined;
      if (!isObject(entry) || typeof entry.targetPath !== "string" || !ref || typeof ref.name !== "string" || typeof ref.key !== "string" || !ENV_NAME.test(ref.key)) {
        throw new Error(`${where}: receivers[${i}] has a valuesFrom entry that is not a secretKeyRef to a key a \${NAME} reference can name`);
      }
      secrets.add(ref.name);
      setPath(settings, entry.targetPath.split("."), `\${${ref.key}}`, where);
    }
    return { ...rest, settings };
  });
  if (secrets.size > 1) {
    throw new Error(`${where}: the receivers read ${[...secrets].map((s) => `"${s}"`).join(" and ")}, and GrafanaOperatorResources takes one secretName`);
  }
  return { receivers: out, ...(secrets.size === 1 ? { secretName: [...secrets][0] } : {}) };
}

/** An `object_matchers` entry as an Alertmanager matcher string, when it can be written as one and read back the same. */
function matcherText(m: unknown): string | undefined {
  if (!Array.isArray(m) || m.length !== 3 || !m.every((x) => typeof x === "string")) return undefined;
  const [label, op, value] = m as [string, string, string];
  if (!/^[^\s=!~]+$/.test(label) || !["=", "!=", "=~", "!~"].includes(op)) return undefined;
  if (value.includes('"') || value.includes("\\")) return undefined;
  return `${label}${op}"${value}"`;
}

/** A route of the policy tree as the provisioning file holds it: `object_matchers` as `matchers` strings, in every nested route. */
export function provisionedRoute(route: Json): Json {
  const { object_matchers, routes, ...rest } = route;
  const out: Json = { ...rest };
  if (Array.isArray(object_matchers) && object_matchers.length > 0) {
    const texts = object_matchers.map(matcherText);
    // Every matcher or none: the build writes object matchers before matchers, so a mix would reorder.
    if (texts.every((t): t is string => t !== undefined)) out.matchers = [...texts, ...(Array.isArray(rest.matchers) ? (rest.matchers as unknown[]) : [])];
    else out.object_matchers = object_matchers;
  }
  if (Array.isArray(routes)) out.routes = routes.map((r) => (isObject(r) ? provisionedRoute(r) : r));
  return out;
}

// ── the importer ─────────────────────────────────────────────────────

function provisioningFile(type: string, spec: Json, warnings: string[]): { file: Json; secretName?: string } {
  const where = `${type.split("::").pop()}`;
  const name = spec.name;
  switch (type) {
    case "K8s::Grafana::GrafanaAlertRuleGroup": {
      if (typeof name !== "string") throw new Error(`${where} has no spec.name`);
      if (!Array.isArray(spec.rules)) throw new Error(`${where} has no spec.rules`);
      const folder = typeof spec.folderRef === "string" ? spec.folderRef : typeof spec.folderUID === "string" ? spec.folderUID : undefined;
      if (folder === undefined) throw new Error(`${where} names no folder (folderRef or folderUID)`);
      warnings.push(
        `rule group "${name}": a declaration's folder is a title, and the resource holds only ${typeof spec.folderRef === "string" ? `the GrafanaFolder name "${folder}" (folderRef)` : `the folder uid "${folder}" (folderUID)`}, so folder is set to that; change it to the folder's title`,
      );
      const group: Json = { name, folder, ...(typeof spec.interval === "string" ? { interval: spec.interval } : {}), rules: spec.rules.map((r) => (isObject(r) ? provisionedRule(r) : r)) };
      return { file: { apiVersion: 1, groups: [group] } };
    }
    case "K8s::Grafana::GrafanaContactPoint": {
      if (typeof name !== "string") throw new Error(`${where} has no spec.name`);
      if (!Array.isArray(spec.receivers)) throw new Error(`${where} has no spec.receivers`);
      const { receivers, secretName } = provisionedReceivers(spec.receivers, `contact point "${name}"`);
      return { file: { apiVersion: 1, contactPoints: [{ name, receivers }] }, secretName };
    }
    case "K8s::Grafana::GrafanaNotificationPolicy": {
      if (!isObject(spec.route)) throw new Error(`${where} has no spec.route`);
      // The routes it selects are their own resources, and a declaration cannot hold the selector: keep it as written.
      if (spec.route.routeSelector !== undefined) throw new Error(`${where} merges routes in with spec.route.routeSelector, which a NotificationPolicy cannot hold`);
      return { file: { apiVersion: 1, policies: [provisionedRoute(spec.route)] } };
    }
    case "K8s::Grafana::GrafanaNotificationPolicyRoute": {
      // The k8s parser offers the whole spec as `route`. A route has no declaration of its own, so it is read as the one child of a policy with its receiver.
      if (!isObject(spec.route) || typeof spec.route.receiver !== "string") throw new Error(`${where} has no spec.receiver`);
      const { routeSelector: _selector, ...route } = spec.route;
      if (_selector !== undefined) warnings.push("the route's routeSelector (routes merged in by label) is not part of a declaration, so it is left out; import the selected routes on their own");
      return { file: { apiVersion: 1, policies: [{ receiver: route.receiver, routes: [provisionedRoute(route)] }] } };
    }
    case "K8s::Grafana::GrafanaMuteTiming": {
      if (typeof name !== "string") throw new Error(`${where} has no spec.name`);
      return { file: { apiVersion: 1, muteTimes: [{ name, time_intervals: spec.time_intervals }] } };
    }
    default: {
      if (typeof name !== "string" || typeof spec.template !== "string") throw new Error(`${where} has no spec.name or spec.template`);
      return { file: { apiVersion: 1, templates: [{ name, template: spec.template }] } };
    }
  }
}

export const operatorImporter: EmbeddedContentImporter = {
  what: "Grafana Operator alerting",

  matches(content: EmbeddedContent) {
    const kind = KINDS[content.hostType];
    return kind !== undefined && content.select === kind.select && isObject(content.document);
  },

  import(content: EmbeddedContent): EmbeddedImport {
    const kind = KINDS[content.hostType];
    const warnings: string[] = [];
    const { file, secretName } = provisioningFile(content.hostType, content.document as Json, warnings);
    const planned = planAlertingProvisioning(file);
    warnings.push(...planned.warnings);

    const declaration = planned.plan.declarations.find((d) => d.className === kind.className);
    const { files, exported } = generatePlanModules(planned.plan);
    const binding = declaration ? exported.get(declaration.id) : undefined;
    if (!binding) throw new Error(`no ${kind.className} was read from ${content.location}: ${planned.warnings.join(" ") || "the alerting importer dropped it"}`);

    if (secretName === undefined) {
      return {
        files,
        value: { bindings: [{ from: binding.path, name: binding.name }], shape: "single", through: { from: K8S_ENTRY, name: kind.through } },
        warnings,
      };
    }
    // A declaration does not know the Secret its settings were read from, so a module of its own names it.
    const module = {
      path: "receivers.ts",
      content: [
        "/** The receivers of the contact point, with its secrets read from the Secret they were in. */",
        `import { operatorReceivers } from "${K8S_ENTRY}";`,
        `import { ${binding.name} } from "./${binding.path.replace(/\.ts$/, "")}";`,
        "",
        `const receivers = operatorReceivers(${binding.name}, ${JSON.stringify(secretName)});`,
        "",
        "export { receivers };",
        "",
      ].join("\n"),
    };
    return { files: [...files, module], value: { bindings: [{ from: module.path, name: "receivers" }], shape: "single" }, warnings };
  },
};
