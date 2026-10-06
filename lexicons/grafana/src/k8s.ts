/**
 * Grafana dashboards and provisioning delivered to Kubernetes as ConfigMaps
 * (#2954), from `@intentius/chant-lexicon-grafana/k8s`.
 *
 * `GrafanaConfigMaps` writes one ConfigMap per dashboard and one for the
 * datasource provisioning file, labelled the way the Grafana Helm chart's
 * sidecar (kiwigrid/k8s-sidecar, also in kube-prometheus-stack) finds them:
 * `grafana_dashboard: "1"` and `grafana_datasource: "1"`. A dashboard's
 * folder goes in the `k8s-sidecar-target-directory` annotation the sidecar
 * reads by default. Each dashboard ConfigMap holds `<uid>.json`, the same
 * text as `dashboardJson(dashboard)`, which is also what the k8s importer
 * turns such a ConfigMap back into (#2962).
 *
 * A Grafana run without the sidecar (a plain Deployment, as in
 * `examples/agent-observability`) mounts the same ConfigMaps with
 * `grafanaVolumes()`, which also needs the dashboard provider file that
 * `GrafanaConfigMaps` writes to a third ConfigMap. The provisioning files go
 * under `/etc/grafana/provisioning` and each dashboard folder is a volume of
 * its own under the provider's path: inside a ConfigMap volume a
 * subdirectory is a symlink, and Grafana's dashboard provider does not
 * follow symlinked directories.
 *
 * A Grafana run by the Grafana Operator reads custom resources instead
 * (#3015): `GrafanaOperatorResources` writes a `GrafanaDashboard` per
 * dashboard, a `GrafanaDatasource` per datasource, a `GrafanaFolder` per
 * folder and a `GrafanaLibraryPanel` per library panel (#3186), and for
 * alerting (#3156) a `GrafanaAlertRuleGroup` per rule group, a
 * `GrafanaContactPoint` per contact point, a `GrafanaNotificationPolicy`, a
 * `GrafanaMuteTiming` per mute timing and a `GrafanaNotificationTemplate` per
 * template, all `grafana.integreatly.org/v1beta1` as the k8s lexicon types
 * them from the operator's CRDs (pinned in its `crd-sources.ts`).
 *
 * This module is the only part of the grafana lexicon that loads the k8s
 * lexicon; nothing else imports it.
 */

import { Composite, type CompositeInstance } from "@intentius/chant/composite";
import type { Declarable } from "@intentius/chant/declarable";
import {
  ConfigMap,
  GrafanaAlertRuleGroup,
  GrafanaContactPoint,
  GrafanaDashboard,
  GrafanaDatasource,
  GrafanaFolder,
  GrafanaLibraryPanel,
  GrafanaMuteTiming,
  GrafanaNotificationPolicy,
  GrafanaNotificationPolicyRoute,
  GrafanaNotificationTemplate,
} from "@intentius/chant-lexicon-k8s/generated/index";
import {
  contactPointJson,
  muteTimingJson,
  notificationPolicyJson,
  notificationTemplateJson,
  ruleGroupJson,
  type ProvisionedAlertRule,
  type ProvisionedContactPoint,
} from "./alerting-build";
import type { AlertRuleGroupEntity, ContactPointEntity, MuteTimingEntity, NotificationPolicyEntity, NotificationTemplateEntity } from "./alerting";
import { compact, slugUid } from "./util";
import { buildGrafana, DASHBOARD_PROVIDERS_FILE, DASHBOARDS_DIR, DATASOURCES_FILE, type ProvisionedDatasource } from "./build";
import { libraryPanelsOf, type LibraryPanelPlan } from "./api/library-panels";
import { DEFAULT_DASHBOARDS_PATH } from "./dashboard";

/** The label the Grafana Helm chart's sidecar looks for on dashboard ConfigMaps (`sidecar.dashboards.label`). */
export const SIDECAR_DASHBOARD_LABEL = "grafana_dashboard";
/** The label it looks for on datasource ConfigMaps (`sidecar.datasources.label`). */
export const SIDECAR_DATASOURCE_LABEL = "grafana_datasource";
/** The annotation the sidecar reads a dashboard's target directory from, by default (its `FOLDER_ANNOTATION`). */
export const SIDECAR_FOLDER_ANNOTATION = "k8s-sidecar-target-directory";

/** Where Grafana reads provisioning files. */
export const GRAFANA_PROVISIONING_PATH = "/etc/grafana/provisioning";

export interface GrafanaConfigMapsProps {
  /** The grafana declarations to deliver: dashboards, datasources, `DashboardProvider`s. Anything else is ignored. */
  entities: Iterable<Declarable>;
  namespace?: string;
  /** Prefix of every ConfigMap name. Defaults to `grafana`. */
  name?: string;
  /** Labels added to every ConfigMap, beside the sidecar's. */
  labels?: Record<string, string>;
  /** The dashboard label as `[key, value]`, or `false` for none. Defaults to `["grafana_dashboard", "1"]`. */
  dashboardLabel?: readonly [string, string] | false;
  /** The datasource label as `[key, value]`, or `false` for none. Defaults to `["grafana_datasource", "1"]`. */
  datasourceLabel?: readonly [string, string] | false;
  /** The annotation holding a dashboard's folder, or `false` for none. Defaults to `k8s-sidecar-target-directory`. */
  folderAnnotation?: string | false;
}

/** The `metadata.name` of each ConfigMap, and which file it holds. */
export interface GrafanaConfigMapLayout {
  dashboards: Array<{ configMap: string; key: string; folder: string; uid: string; text: string }>;
  datasources?: { configMap: string; key: string; text: string };
  providers?: { configMap: string; key: string; text: string };
}

/** A DNS-1123 subdomain made from a name: lower case, `[a-z0-9-.]`, at most 253 characters. */
function dnsName(text: string): string {
  const out = text
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  return (out || "x").slice(0, 253).replace(/[^a-z0-9]+$/, "");
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Which ConfigMap each file goes in, and under which key. `GrafanaConfigMaps` and `grafanaVolumes` both read it. */
export function grafanaConfigMapLayout(props: Pick<GrafanaConfigMapsProps, "entities" | "name">): GrafanaConfigMapLayout {
  const prefix = props.name ?? "grafana";
  const built = buildGrafana(props.entities);
  const taken = new Set<string>();
  const unique = (base: string) => {
    let out = base;
    for (let n = 2; taken.has(out); n++) out = `${base}-${n}`;
    taken.add(out);
    return out;
  };
  const layout: GrafanaConfigMapLayout = {
    dashboards: built.dashboards.map((d) => {
      const dir = d.file.slice(DASHBOARDS_DIR.length + 1, d.file.lastIndexOf("/") + 1).replace(/\/$/, "");
      return { configMap: unique(dnsName(`${prefix}-dashboard-${d.uid}`)), key: basename(d.file), folder: dir, uid: d.uid, text: built.files[d.file] };
    }),
  };
  if (built.files[DATASOURCES_FILE] !== undefined) {
    layout.datasources = { configMap: unique(dnsName(`${prefix}-datasources`)), key: basename(DATASOURCES_FILE), text: built.files[DATASOURCES_FILE] };
  }
  if (built.files[DASHBOARD_PROVIDERS_FILE] !== undefined) {
    layout.providers = { configMap: unique(dnsName(`${prefix}-dashboard-providers`)), key: basename(DASHBOARD_PROVIDERS_FILE), text: built.files[DASHBOARD_PROVIDERS_FILE] };
  }
  return layout;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ConfigMapEntity = InstanceType<typeof ConfigMap> & Declarable;

export type GrafanaConfigMapsMembers = Record<string, ConfigMapEntity>;
export type GrafanaConfigMapsInstance = CompositeInstance<GrafanaConfigMapsMembers> & GrafanaConfigMapsMembers;

/** A member name from a ConfigMap name: `grafana-dashboard-red` becomes `dashboardRed`. */
function memberName(configMap: string, prefix: string): string {
  const rest = configMap.startsWith(`${prefix}-`) ? configMap.slice(prefix.length + 1) : configMap;
  const words = rest.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words.map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))).join("") || "configMap";
}

/**
 * One ConfigMap per dashboard, one for the datasources and one for the
 * dashboard provider, labelled for the Grafana sidecar. Export the result
 * from a k8s build root; the members are named after the ConfigMaps
 * (`dashboardGenaiAgents`, `datasources`, `dashboardProviders`).
 */
export const GrafanaConfigMaps = Composite<GrafanaConfigMapsProps, GrafanaConfigMapsMembers>((props) => {
  const prefix = dnsName(props.name ?? "grafana");
  const layout = grafanaConfigMapLayout({ ...props, name: prefix });
  const dashboardLabel = props.dashboardLabel === undefined ? ([SIDECAR_DASHBOARD_LABEL, "1"] as const) : props.dashboardLabel;
  const datasourceLabel = props.datasourceLabel === undefined ? ([SIDECAR_DATASOURCE_LABEL, "1"] as const) : props.datasourceLabel;
  const folderAnnotation = props.folderAnnotation === undefined ? SIDECAR_FOLDER_ANNOTATION : props.folderAnnotation;

  const metadata = (name: string, label: readonly [string, string] | false, annotations?: Record<string, string>) => ({
    name,
    ...(props.namespace ? { namespace: props.namespace } : {}),
    labels: { ...(props.labels ?? {}), ...(label ? { [label[0]]: label[1] } : {}) },
    ...(annotations ? { annotations } : {}),
  });

  const members: GrafanaConfigMapsMembers = {};
  for (const d of layout.dashboards) {
    const annotations = folderAnnotation && d.folder ? { [folderAnnotation]: d.folder } : undefined;
    members[memberName(d.configMap, prefix)] = new ConfigMap({ metadata: metadata(d.configMap, dashboardLabel, annotations), data: { [d.key]: d.text } }) as ConfigMapEntity;
  }
  for (const f of [layout.datasources, layout.providers]) {
    if (!f) continue;
    const label = f === layout.datasources ? datasourceLabel : false;
    members[memberName(f.configMap, prefix)] = new ConfigMap({ metadata: metadata(f.configMap, label), data: { [f.key]: f.text } }) as ConfigMapEntity;
  }
  return members;
}, "GrafanaConfigMaps");

export interface GrafanaVolumesOptions {
  /** Where the dashboard provider reads dashboards. Defaults to `/var/lib/grafana/dashboards`, the provider chant writes by default. */
  dashboardsPath?: string;
  /** Prefix of the volume names. Defaults to `grafana`. */
  volumeName?: string;
}

export interface GrafanaVolumes {
  volumes: Array<Record<string, unknown>>;
  volumeMounts: Array<{ name: string; mountPath: string; readOnly: true }>;
}

/**
 * The pod volumes and container mounts that put `GrafanaConfigMaps`'s files
 * where a Grafana without the sidecar reads them: the provisioning files
 * under `/etc/grafana/provisioning`, and each dashboard folder under the
 * provider's path, one projected volume per folder. Pass the same `entities`
 * and `name` as to `GrafanaConfigMaps`.
 */
export function grafanaVolumes(props: Pick<GrafanaConfigMapsProps, "entities" | "name">, options: GrafanaVolumesOptions = {}): GrafanaVolumes {
  const prefix = dnsName(props.name ?? "grafana");
  const layout = grafanaConfigMapLayout({ ...props, name: prefix });
  const vol = dnsName(options.volumeName ?? prefix);
  const root = (options.dashboardsPath ?? DEFAULT_DASHBOARDS_PATH).replace(/\/+$/, "");
  const volumes: GrafanaVolumes["volumes"] = [];
  const volumeMounts: GrafanaVolumes["volumeMounts"] = [];

  const provisioning = [
    ...(layout.datasources ? [{ configMap: { name: layout.datasources.configMap, items: [{ key: layout.datasources.key, path: `datasources/${layout.datasources.key}` }] } }] : []),
    ...(layout.providers ? [{ configMap: { name: layout.providers.configMap, items: [{ key: layout.providers.key, path: `dashboards/${layout.providers.key}` }] } }] : []),
  ];
  if (provisioning.length > 0) {
    volumes.push({ name: `${vol}-provisioning`, projected: { sources: provisioning } });
    volumeMounts.push({ name: `${vol}-provisioning`, mountPath: GRAFANA_PROVISIONING_PATH, readOnly: true });
  }

  const folders = [...new Set(layout.dashboards.map((d) => d.folder))].sort();
  folders.forEach((folder, i) => {
    const name = `${vol}-dashboards-${i}`;
    const sources = layout.dashboards
      .filter((d) => d.folder === folder)
      .map((d) => ({ configMap: { name: d.configMap, items: [{ key: d.key, path: d.key }] } }));
    volumes.push({ name, projected: { sources } });
    volumeMounts.push({ name, mountPath: folder ? `${root}/${folder}` : root, readOnly: true });
  });
  return { volumes, volumeMounts };
}

// ── Grafana Operator delivery (#3015) ─────────────────────────────────

/** The `spec.instanceSelector` of every operator resource: which `Grafana` custom resources take it. */
export interface GrafanaInstanceSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: Array<{ key: string; operator: "In" | "NotIn" | "Exists" | "DoesNotExist"; values?: string[] }>;
}

export interface GrafanaOperatorResourcesProps {
  /** The grafana declarations to deliver: dashboards (with the library panels they place), datasources and `Folder`s. Anything else is ignored. */
  entities: Iterable<Declarable>;
  /**
   * Which `Grafana` resources pick these up, usually the labels on your
   * `Grafana` custom resource (the operator's examples use
   * `{ matchLabels: { dashboards: "grafana" } }`). The operator requires one,
   * and one that matches nothing delivers nothing, so there is no default.
   */
  instanceSelector: GrafanaInstanceSelector;
  namespace?: string;
  /** Prefix of every resource name. Defaults to `grafana`. */
  name?: string;
  /** Labels added to every resource. */
  labels?: Record<string, string>;
  /** Let a `Grafana` in another namespace take these resources (`spec.allowCrossNamespaceImport`). */
  allowCrossNamespaceImport?: boolean;
  /** How often the operator re-applies each resource (`spec.resyncPeriod`, e.g. `"5m"`). The operator's default is 10m. */
  resyncPeriod?: string;
  /**
   * Where each `GrafanaDashboard` reads its JSON from. `"json"` (the default)
   * puts `dashboardJson(dashboard)` in `spec.json`. `"configMap"` points
   * `spec.configMapRef` at the ConfigMap `GrafanaConfigMaps` writes for the
   * same dashboard, for a build that exports both with the same `name`, so
   * the JSON is stored once.
   */
  dashboardSource?: "json" | "configMap";
  /**
   * The Secret that datasource and contact point secrets come from. A
   * datasource field written as `${NAME}` or `$__env{NAME}` (the way file
   * provisioning reads the environment) becomes a `spec.valuesFrom` entry
   * reading key `NAME` of this Secret, which the operator substitutes for
   * `${NAME}`. A contact point setting that is entirely such a reference
   * becomes a `valuesFrom` entry of its receiver, which the operator writes
   * into the setting at `targetPath`. Required when any datasource or
   * contact point has such a reference.
   */
  secretName?: string;
  /**
   * Write each direct child route of a notification policy as a
   * `GrafanaNotificationPolicyRoute` of its own, which the policy merges in
   * through `spec.route.routeSelector` (the operator allows `routes` or
   * `routeSelector`, not both). The routes carry the label
   * `grafana.chant.dev/policy: <policy resource name>`, which the selector
   * matches. A route's own nested routes stay inline in its `spec.routes`.
   * Defaults to false: the whole tree inline in `spec.route`.
   */
  policyRoutes?: boolean;
}

type OperatorEntity = (
  | InstanceType<typeof GrafanaDashboard>
  | InstanceType<typeof GrafanaDatasource>
  | InstanceType<typeof GrafanaFolder>
  | InstanceType<typeof GrafanaLibraryPanel>
  | InstanceType<typeof GrafanaAlertRuleGroup>
  | InstanceType<typeof GrafanaContactPoint>
  | InstanceType<typeof GrafanaNotificationPolicy>
  | InstanceType<typeof GrafanaNotificationPolicyRoute>
  | InstanceType<typeof GrafanaMuteTiming>
  | InstanceType<typeof GrafanaNotificationTemplate>
) &
  Declarable;

export type GrafanaOperatorResourcesMembers = Record<string, OperatorEntity>;
export type GrafanaOperatorResourcesInstance = CompositeInstance<GrafanaOperatorResourcesMembers> & GrafanaOperatorResourcesMembers;

/** The fields of a datasource that file provisioning expands variables in, and the operator substitutes `valuesFrom` into. */
const DATASOURCE_STRING_FIELDS = ["url", "user", "basicAuthUser", "database"] as const;

const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$__env\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z][A-Za-z0-9_]*)/g;

/**
 * A provisioned datasource as `GrafanaDatasource.spec.datasource`, and the
 * `valuesFrom` entries its `${NAME}` references need. `$__env{NAME}` is
 * rewritten to `${NAME}`, the form the operator substitutes. Fields the CRD
 * does not have (`withCredentials`, `version`) and the ones the operator
 * overrides (`uid`, which goes in `spec.uid`, and `orgId`) are left out.
 */
export function operatorDatasource(
  ds: ProvisionedDatasource,
  secretName: string | undefined,
): { datasource: Record<string, unknown>; valuesFrom: Array<Record<string, unknown>> } {
  const { uid: _uid, orgId: _orgId, withCredentials: _wc, version: _version, ...rest } = ds;
  const datasource: Record<string, unknown> = { ...rest };
  const valuesFrom: Array<Record<string, unknown>> = [];
  const substitute = (targetPath: string, value: string): string => {
    if (value.includes("$__file{")) {
      throw new Error(`grafana: datasource "${ds.name}" reads ${targetPath} from a file ($__file{...}); the Grafana Operator cannot, so give it as \${NAME} from a Secret instead`);
    }
    const names = new Set<string>();
    const out = value.replace(VARIABLE, (match, braced?: string, env?: string, bare?: string) => {
      const name = braced ?? env ?? bare!;
      names.add(name);
      return env ? `\${${name}}` : match;
    });
    if (names.size > 0 && !secretName) {
      throw new Error(
        `grafana: datasource "${ds.name}" reads ${[...names].map((n) => `\${${n}}`).join(", ")} in ${targetPath}; ` +
          "pass secretName to GrafanaOperatorResources, the Secret holding those keys",
      );
    }
    for (const key of [...names].sort()) valuesFrom.push({ targetPath, valueFrom: { secretKeyRef: { name: secretName, key } } });
    return out;
  };
  for (const field of DATASOURCE_STRING_FIELDS) {
    const value = datasource[field];
    if (typeof value === "string") datasource[field] = substitute(field, value);
  }
  if (ds.secureJsonData) {
    datasource.secureJsonData = Object.fromEntries(
      Object.entries(ds.secureJsonData).map(([key, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          throw new Error(`grafana: datasource "${ds.name}" has the secureJsonData key "${key}", which the operator's valuesFrom targetPath cannot address`);
        }
        return [key, substitute(`secureJsonData.${key}`, value)];
      }),
    );
  }
  return { datasource, valuesFrom };
}

// ── Alerting (#3156) ──────────────────────────────────────────────────

/** The label a `GrafanaNotificationPolicyRoute` carries for the policy whose `routeSelector` merges it in. */
export const POLICY_ROUTE_LABEL = "grafana.chant.dev/policy";

/**
 * A setting that is wholly a reference to a variable: `${NAME}`, `$__env{NAME}` or `$NAME`.
 * The bare `$labels`, `$value` and `$values` are alert template variables, not environment
 * variables, so a setting of exactly that text is left as written.
 */
const WHOLE_VARIABLE = /^(?:\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$__env\{([A-Za-z_][A-Za-z0-9_]*)\}|\$(?!(?:labels|values?)$)([A-Za-z_][A-Za-z0-9_]*))$/;
/** A braced reference inside longer text, which `valuesFrom` cannot substitute into. */
const EMBEDDED_VARIABLE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$__env\{[^}]*\}|\$__(?:file|vault)\{[^}]*\}/;

/**
 * One contact point receiver's settings for `spec.receivers[].settings`, and
 * the `valuesFrom` entries for the secrets in it. A setting that is wholly
 * `${NAME}` (or `$__env{NAME}`, `$NAME`) is taken out of `settings` and read
 * from key `NAME` of `secretName` into the same path by the operator, whose
 * `targetPath` is a dotted path inside the settings. A reference inside
 * longer text, or a `$__file` or `$__vault` one, is an error: the operator
 * can only replace a whole value.
 */
export function operatorReceiverSettings(
  where: string,
  settings: Record<string, unknown>,
  secretName: string | undefined,
): { settings: Record<string, unknown>; valuesFrom: Array<Record<string, unknown>> } {
  const valuesFrom: Array<Record<string, unknown>> = [];
  const walk = (node: Record<string, unknown>, path: string[]): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      const here = [...path, key];
      if (typeof value === "string") {
        const whole = WHOLE_VARIABLE.exec(value);
        if (whole) {
          if (here.some((seg) => seg.includes("."))) {
            throw new Error(`grafana: ${where} reads ${here.join(".")} from ${value}, and the operator's valuesFrom targetPath cannot address a key containing "."`);
          }
          if (!secretName) {
            throw new Error(`grafana: ${where} reads ${value} in ${here.join(".")}; pass secretName to GrafanaOperatorResources, the Secret holding that key`);
          }
          valuesFrom.push({ targetPath: here.join("."), valueFrom: { secretKeyRef: { name: secretName, key: whole[1] ?? whole[2] ?? whole[3] } } });
          continue;
        }
        if (EMBEDDED_VARIABLE.test(value)) {
          throw new Error(`grafana: ${where} has a variable inside the text of ${here.join(".")}; the operator can only fill a whole setting from a Secret, so make it exactly \${NAME}`);
        }
        out[key] = value;
      } else if (Array.isArray(value)) {
        // Inside a list a value has no path the operator can write to.
        if (EMBEDDED_VARIABLE.test(JSON.stringify(value))) throw new Error(`grafana: ${where} has a variable inside the list ${here.join(".")}, which the operator cannot fill from a Secret`);
        out[key] = value;
      } else if (value !== null && typeof value === "object") {
        out[key] = walk(value as Record<string, unknown>, here);
      } else {
        out[key] = value;
      }
    }
    return out;
  };
  return { settings: walk(settings, []), valuesFrom };
}

/** One contact point as `GrafanaContactPoint.spec`: its name, and its receivers with their secrets in `valuesFrom`. */
export function operatorContactPoint(cp: ProvisionedContactPoint, secretName: string | undefined): Record<string, unknown> {
  return {
    name: cp.name,
    receivers: cp.receivers.map((r) => {
      const { settings, valuesFrom } = operatorReceiverSettings(`contact point "${cp.name}" receiver "${r.uid}"`, r.settings, secretName);
      return {
        uid: r.uid,
        type: r.type,
        settings,
        ...(r.disableResolveMessage !== undefined ? { disableResolveMessage: r.disableResolveMessage } : {}),
        ...(valuesFrom.length > 0 ? { valuesFrom } : {}),
      };
    }),
  };
}

/**
 * One rule as an entry of `GrafanaAlertRuleGroup.spec.rules`. The CRD spells
 * two fields in camel case (`missingSeriesEvalsToResolve`,
 * `notificationSettings`), requires `for`, `noDataState` and `execErrState`
 * (Grafana's defaults fill them), and has no use for `dashboardUid` and
 * `panelId`, which it reads from the `__dashboardUid__` and `__panelId__`
 * annotations.
 */
export function operatorRule(rule: ProvisionedAlertRule): Record<string, unknown> {
  const { dashboardUid, panelId, missing_series_evals_to_resolve, notification_settings, noDataState, execErrState, for: forDuration, condition, annotations, ...rest } = rule;
  const notes = {
    ...(annotations ?? {}),
    ...(dashboardUid !== undefined ? { __dashboardUid__: dashboardUid } : {}),
    ...(panelId !== undefined ? { __panelId__: String(panelId) } : {}),
  };
  const record = rule.record as { from?: string } | undefined;
  return compact({
    ...rest,
    condition: condition ?? record?.from ?? "",
    for: forDuration ?? "0s",
    noDataState: noDataState ?? "NoData",
    execErrState: execErrState ?? "Alerting",
    annotations: Object.keys(notes).length > 0 ? notes : undefined,
    missingSeriesEvalsToResolve: missing_series_evals_to_resolve,
    notificationSettings: notification_settings,
  });
}

/** An Alertmanager matcher string (`severity="page"`, `team=~"a|b"`) as Grafana's `[label, operator, value]`. */
function objectMatcher(text: string): [string, string, string] {
  const m = /^\s*([^\s=!~]+)\s*(=~|!~|!=|=)\s*(.*?)\s*$/.exec(text);
  if (!m) throw new Error(`grafana: cannot read the route matcher ${JSON.stringify(text)} as label, operator and value`);
  const value = m[3].length >= 2 && m[3].startsWith('"') && m[3].endsWith('"') ? m[3].slice(1, -1) : m[3];
  return [m[1], m[2], value];
}

/**
 * A route of the policy tree for the operator. The operator's `routes` are
 * Grafana's API routes, whose `matchers` are objects, so the Alertmanager
 * strings in `matchers` are moved into `object_matchers`.
 */
function operatorRoute(route: Record<string, unknown>): Record<string, unknown> {
  const { matchers, routes, object_matchers, ...rest } = route as {
    matchers?: string[];
    routes?: Array<Record<string, unknown>>;
    object_matchers?: unknown[];
    [key: string]: unknown;
  };
  const objects = [...(object_matchers ?? []), ...(matchers ?? []).map(objectMatcher)];
  return compact({ ...rest, object_matchers: objects.length > 0 ? objects : undefined, routes: routes?.map(operatorRoute) });
}

/** One policy tree as `GrafanaNotificationPolicy.spec.route`. `orgId` is the operator's to set, so it is left out. */
export function operatorPolicyRoute(policy: Record<string, unknown>): Record<string, unknown> {
  const { orgId: _orgId, ...route } = policy;
  return operatorRoute(route);
}

/**
 * The fields `chant import` writes into an imported Grafana Operator
 * resource (#3538): each takes the alerting declaration the field was read
 * into and gives the field `GrafanaOperatorResources` writes for it, so the
 * resource builds back to what was imported.
 */

/** `GrafanaAlertRuleGroup.spec.rules` for a rule group. */
export function operatorRules(group: AlertRuleGroupEntity): Array<Record<string, unknown>> {
  return ruleGroupJson(group).rules.map(operatorRule);
}

/** `GrafanaContactPoint.spec.receivers` for a contact point, its `${NAME}` secrets read from `secretName`. */
export function operatorReceivers(cp: ContactPointEntity, secretName?: string): Array<Record<string, unknown>> {
  return operatorContactPoint(contactPointJson(cp), secretName).receivers as Array<Record<string, unknown>>;
}

/** `GrafanaNotificationPolicy.spec.route` for a policy tree. */
export function operatorPolicy(policy: NotificationPolicyEntity): Record<string, unknown> {
  return operatorPolicyRoute(notificationPolicyJson(policy));
}

/**
 * `GrafanaNotificationPolicyRoute.spec` for a policy declaration holding the
 * route as its one child: the child's fields, with `receiver` always set
 * (the CRD requires it, so a child that inherits it gets the policy's).
 */
export function operatorRouteSpec(policy: NotificationPolicyEntity): Record<string, unknown> {
  const tree = operatorPolicy(policy);
  const routes = tree.routes as Array<Record<string, unknown>> | undefined;
  const child = routes?.[0];
  if (!child) throw new Error("grafana: the policy has no child route to write as a GrafanaNotificationPolicyRoute");
  return { ...child, receiver: child.receiver ?? tree.receiver };
}

/** `GrafanaMuteTiming.spec.time_intervals` for a mute timing. */
export function operatorTimeIntervals(timing: MuteTimingEntity): Array<Record<string, unknown>> {
  return muteTimingJson(timing).time_intervals;
}

/** `GrafanaNotificationTemplate.spec.template` for a template. */
export function operatorTemplate(template: NotificationTemplateEntity): string {
  return notificationTemplateJson(template).template;
}

/**
 * The Grafana Operator's custom resources for a set of grafana declarations
 * (`grafana.integreatly.org/v1beta1`, Grafana Operator v5.25.0):
 *
 * - a `GrafanaFolder` per folder, `<name>-folder-<uid>`, with the folder's uid,
 *   its title, and its parent as `parentFolderRef`;
 * - a `GrafanaLibraryPanel` per library panel the dashboards place,
 *   `<name>-library-panel-<uid>`, holding its model with its `name` and `uid`
 *   in `spec.json` and naming its folder with `folderRef`. File provisioning
 *   and a `GrafanaDashboard`'s `__elements` do not create library panels, so
 *   without these a dashboard's library panel references stay empty;
 * - a `GrafanaDashboard` per dashboard, `<name>-dashboard-<uid>`, holding
 *   `dashboardJson(dashboard)` in `spec.json` and naming its folder with
 *   `folderRef`;
 * - a `GrafanaDatasource` per datasource, `<name>-datasource-<uid>`;
 * - for the alerting the build declares: a `GrafanaAlertRuleGroup` per rule
 *   group, `<name>-rule-group-<folder>-<group>`, in the `GrafanaFolder` whose
 *   title is the group's `folder` (one is written when no folder has it);
 *   a `GrafanaContactPoint` per contact point, `<name>-contact-point-<name>`,
 *   whose `${NAME}` secrets go to each receiver's `valuesFrom`; a
 *   `GrafanaNotificationPolicy`, `<name>-notification-policy`, with its
 *   nested routes inline (or, with `policyRoutes`, one
 *   `GrafanaNotificationPolicyRoute` per direct child route, selected by
 *   label); a `GrafanaMuteTiming` per mute timing and a
 *   `GrafanaNotificationTemplate` per template.
 *
 * Every resource carries `instanceSelector`. Export the result from a k8s
 * build root, beside or instead of `GrafanaConfigMaps`.
 */
export const GrafanaOperatorResources = Composite<GrafanaOperatorResourcesProps, GrafanaOperatorResourcesMembers>((props) => {
  const prefix = dnsName(props.name ?? "grafana");
  const built = buildGrafana(props.entities);
  const taken = new Set<string>();
  const unique = (base: string) => {
    let out = dnsName(base);
    for (let n = 2; taken.has(out); n++) out = `${dnsName(base)}-${n}`;
    taken.add(out);
    return out;
  };
  const metadata = (name: string) => ({
    name,
    ...(props.namespace ? { namespace: props.namespace } : {}),
    ...(props.labels ? { labels: { ...props.labels } } : {}),
  });
  const common = {
    instanceSelector: props.instanceSelector,
    ...(props.allowCrossNamespaceImport !== undefined ? { allowCrossNamespaceImport: props.allowCrossNamespaceImport } : {}),
    ...(props.resyncPeriod !== undefined ? { resyncPeriod: props.resyncPeriod } : {}),
  };
  const members: GrafanaOperatorResourcesMembers = {};

  // Folders first, parents before children (FolderPlan is sorted by path), so a child's parentFolderRef names a resource already made.
  const folderRef = new Map<string, string>();
  for (const f of built.folders) {
    if (folderRef.has(f.uid)) continue; // two paths with one uid: GRAF104 reports it; one resource can hold only one
    const name = unique(`${prefix}-folder-${f.uid}`);
    folderRef.set(f.uid, name);
    const parent = f.parentUid !== undefined ? folderRef.get(f.parentUid) : undefined;
    members[memberName(name, prefix)] = new GrafanaFolder({
      metadata: metadata(name),
      spec: { ...common, uid: f.uid, title: f.title, ...(parent ? { parentFolderRef: parent } : {}) },
    }) as OperatorEntity;
  }

  // Library panels next, each once. Its folder is the one its `LibraryPanel`
  // names, else that of the first dashboard placing it, as the API applier does.
  const libraryPanels = new Map<string, LibraryPanelPlan>();
  for (const d of built.dashboards) {
    for (const lp of libraryPanelsOf(d.json as unknown as Record<string, unknown>, d.folderUid).panels) {
      if (!libraryPanels.has(lp.uid)) libraryPanels.set(lp.uid, lp);
    }
  }
  for (const lp of libraryPanels.values()) {
    const name = unique(`${prefix}-library-panel-${lp.uid}`);
    const folder = lp.folderUid !== undefined ? folderRef.get(lp.folderUid) : undefined;
    const placement = folder ? { folderRef: folder } : lp.folderUid !== undefined ? { folderUID: lp.folderUid } : {};
    members[memberName(name, prefix)] = new GrafanaLibraryPanel({
      metadata: metadata(name),
      // The operator takes the element's name from the model's `name`, and its uid from `spec.uid` (else the model's).
      spec: { ...common, uid: lp.uid, json: JSON.stringify({ ...lp.model, name: lp.name, uid: lp.uid }, null, 2), ...placement },
    }) as OperatorEntity;
  }

  const configMaps = props.dashboardSource === "configMap" ? grafanaConfigMapLayout({ entities: props.entities, name: prefix }).dashboards : undefined;
  built.dashboards.forEach((d, i) => {
    const name = unique(`${prefix}-dashboard-${d.uid}`);
    const folder = d.folderUid !== undefined ? folderRef.get(d.folderUid) : undefined;
    const source = configMaps
      ? { configMapRef: { name: configMaps[i].configMap, key: configMaps[i].key } }
      : { json: built.files[d.file] };
    members[memberName(name, prefix)] = new GrafanaDashboard({
      metadata: metadata(name),
      spec: { ...common, ...source, ...(folder ? { folderRef: folder } : {}) },
    }) as OperatorEntity;
  });

  for (const ds of built.datasources) {
    const name = unique(`${prefix}-datasource-${ds.uid}`);
    const { datasource, valuesFrom } = operatorDatasource(ds, props.secretName);
    members[memberName(name, prefix)] = new GrafanaDatasource({
      metadata: metadata(name),
      spec: { ...common, uid: ds.uid, datasource, ...(valuesFrom.length > 0 ? { valuesFrom } : {}) },
    }) as OperatorEntity;
  }

  const alerting = built.alerting;
  if (alerting) {
    // A rule group names its folder by title. Use the folder with that title (a root one first), else write one.
    const folderByTitle = new Map<string, string>();
    for (const f of built.folders) {
      const ref = folderRef.get(f.uid);
      if (ref && (!folderByTitle.has(f.title) || f.parentUid === undefined)) folderByTitle.set(f.title, ref);
    }
    const folderFor = (title: string): string => {
      const known = folderByTitle.get(title);
      if (known) return known;
      const uid = slugUid(title);
      const name = unique(`${prefix}-folder-${uid}`);
      members[memberName(name, prefix)] = new GrafanaFolder({ metadata: metadata(name), spec: { ...common, uid, title } }) as OperatorEntity;
      folderByTitle.set(title, name);
      return name;
    };

    for (const g of alerting.groups ?? []) {
      const folder = folderFor(g.folder);
      const name = unique(`${prefix}-rule-group-${slugUid(g.folder)}-${slugUid(g.name)}`);
      members[memberName(name, prefix)] = new GrafanaAlertRuleGroup({
        metadata: metadata(name),
        spec: { ...common, name: g.name, folderRef: folder, interval: g.interval, rules: g.rules.map(operatorRule) },
      }) as OperatorEntity;
    }
    for (const cp of alerting.contactPoints ?? []) {
      const name = unique(`${prefix}-contact-point-${slugUid(cp.name)}`);
      members[memberName(name, prefix)] = new GrafanaContactPoint({
        metadata: metadata(name),
        spec: { ...common, ...operatorContactPoint(cp, props.secretName) },
      }) as OperatorEntity;
    }
    for (const policy of alerting.policies ?? []) {
      const name = unique(`${prefix}-notification-policy`);
      const tree = operatorPolicyRoute(policy);
      const children = Array.isArray(tree.routes) ? (tree.routes as Array<Record<string, unknown>>) : [];
      if (props.policyRoutes && children.length > 0) {
        const { routes: _inline, ...root } = tree;
        const selector = { [POLICY_ROUTE_LABEL]: name };
        members[memberName(name, prefix)] = new GrafanaNotificationPolicy({
          metadata: metadata(name),
          spec: { ...common, route: { ...root, routeSelector: { matchLabels: selector } } },
        }) as OperatorEntity;
        children.forEach((child, i) => {
          const routeName = unique(`${prefix}-notification-policy-route-${i + 1}`);
          members[memberName(routeName, prefix)] = new GrafanaNotificationPolicyRoute({
            metadata: { ...metadata(routeName), labels: { ...(props.labels ?? {}), ...selector } },
            spec: { ...child, receiver: child.receiver ?? tree.receiver },
          }) as OperatorEntity;
        });
        continue;
      }
      members[memberName(name, prefix)] = new GrafanaNotificationPolicy({
        metadata: metadata(name),
        spec: { ...common, route: tree },
      }) as OperatorEntity;
    }
    for (const t of alerting.muteTimes ?? []) {
      const name = unique(`${prefix}-mute-timing-${slugUid(t.name)}`);
      members[memberName(name, prefix)] = new GrafanaMuteTiming({
        metadata: metadata(name),
        spec: { ...common, name: t.name, time_intervals: t.time_intervals },
      }) as OperatorEntity;
    }
    for (const t of alerting.templates ?? []) {
      const name = unique(`${prefix}-notification-template-${slugUid(t.name)}`);
      members[memberName(name, prefix)] = new GrafanaNotificationTemplate({
        metadata: metadata(name),
        spec: { ...common, name: t.name, template: t.template },
      }) as OperatorEntity;
    }
  }
  return members;
}, "GrafanaOperatorResources");
