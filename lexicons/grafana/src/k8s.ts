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
 * dashboard, a `GrafanaDatasource` per datasource and a `GrafanaFolder` per
 * folder, all `grafana.integreatly.org/v1beta1` as the k8s lexicon types
 * them from the operator's CRDs (pinned in its `crd-sources.ts`).
 *
 * This module is the only part of the grafana lexicon that loads the k8s
 * lexicon; nothing else imports it.
 */

import { Composite, type CompositeInstance } from "@intentius/chant/composite";
import type { Declarable } from "@intentius/chant/declarable";
import { ConfigMap, GrafanaDashboard, GrafanaDatasource, GrafanaFolder } from "@intentius/chant-lexicon-k8s/generated/index";
import { buildGrafana, DASHBOARD_PROVIDERS_FILE, DASHBOARDS_DIR, DATASOURCES_FILE, type ProvisionedDatasource } from "./build";
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
  /** The grafana declarations to deliver: dashboards, datasources and `Folder`s. Anything else is ignored. */
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
   * The Secret that datasource secrets come from. A datasource field written
   * as `${NAME}` or `$__env{NAME}` (the way file provisioning reads the
   * environment) becomes a `spec.valuesFrom` entry reading key `NAME` of
   * this Secret, which the operator substitutes for `${NAME}`. Required when
   * any datasource has such a reference.
   */
  secretName?: string;
}

type OperatorEntity = (InstanceType<typeof GrafanaDashboard> | InstanceType<typeof GrafanaDatasource> | InstanceType<typeof GrafanaFolder>) & Declarable;

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

/**
 * The Grafana Operator's custom resources for a set of grafana declarations
 * (`grafana.integreatly.org/v1beta1`, Grafana Operator v5.25.0):
 *
 * - a `GrafanaFolder` per folder, `<name>-folder-<uid>`, with the folder's uid,
 *   its title, and its parent as `parentFolderRef`;
 * - a `GrafanaDashboard` per dashboard, `<name>-dashboard-<uid>`, holding
 *   `dashboardJson(dashboard)` in `spec.json` and naming its folder with
 *   `folderRef`;
 * - a `GrafanaDatasource` per datasource, `<name>-datasource-<uid>`.
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
  return members;
}, "GrafanaOperatorResources");
