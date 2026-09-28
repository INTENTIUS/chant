/**
 * Grafana as a plain Deployment, provisioned from the files this build
 * root's grafana entities render to. `grafanaFiles()` returns exactly what
 * `chant build --lexicon grafana` writes: the datasource and dashboard
 * provisioning files, and one JSON file per dashboard. They go into one
 * ConfigMap (a key holds only letters, digits, `-`, `.` and `_`, so each
 * path's slashes become `__` and anything else `_`), mounted with `items`
 * putting each file back at its path: the provisioning files under
 * /etc/grafana/provisioning, the dashboards under /var/lib/grafana/dashboards,
 * where the provisioned provider reads them.
 *
 * Each dashboard folder is a mount of its own. Inside a ConfigMap volume a
 * subdirectory is a symlink, and Grafana's dashboard provider walks the tree
 * without following symlinked directories, so a folder mounted as part of one
 * volume would be skipped.
 *
 * Anonymous viewers are let in so the dashboards open without a login on a
 * laptop cluster, and Grafana installs no plugins at startup.
 */
import { ConfigMap, Deployment, Service } from "@intentius/chant-lexicon-k8s";
import { grafanaFiles } from "@intentius/chant-lexicon-grafana";
import { prometheusDatasource, tempoDatasource, lokiDatasource } from "./datasources";
import { services, agentSlo, agentCalls } from "./dashboards";
import { NAMESPACE } from "./namespace";

export const GRAFANA_IMAGE = "grafana/grafana:12.4.11";

const files = grafanaFiles([
  prometheusDatasource,
  tempoDatasource,
  lokiDatasource,
  services.dashboard,
  agentSlo.dashboard,
  agentCalls.dashboard,
]);
const keyOf = (path: string): string => path.replaceAll("/", "__").replace(/[^-._a-zA-Z0-9]/g, "_");
const under = (prefix: string) =>
  Object.keys(files)
    .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
    .map((path) => ({ key: keyOf(path), path: path.slice(prefix.length) }));

const PROVISIONING_PATH = "/etc/grafana/provisioning";
const DASHBOARDS_PATH = "/var/lib/grafana/dashboards";
const provisioningItems = Object.keys(files)
  .filter((path) => path.startsWith("provisioning/"))
  .map((path) => ({ key: keyOf(path), path: path.slice("provisioning/".length) }));

/** The directories holding dashboard JSON, relative to `dashboards/`: "" for the top, then one per folder. */
const dashboardDirs = Array.from(
  new Set(
    Object.keys(files)
      .filter((path) => path.startsWith("dashboards/") && path.endsWith(".json"))
      .map((path) => path.slice("dashboards/".length, path.lastIndexOf("/") + 1)),
  ),
).sort();
const dashboardVolumes = dashboardDirs.map((dir, i) => ({
  name: `dashboards-${i}`,
  configMap: { name: "grafana-files", items: under(`dashboards/${dir}`) },
}));
const dashboardMounts = dashboardDirs.map((dir, i) => ({
  name: `dashboards-${i}`,
  mountPath: `${DASHBOARDS_PATH}/${dir}`.replace(/\/$/, ""),
  readOnly: true,
}));

const grafanaLabels = { "app.kubernetes.io/name": "grafana", "app.kubernetes.io/component": "dashboards" };
const grafanaSelector = { "app.kubernetes.io/name": "grafana" };

const grafanaFilesMeta = { name: "grafana-files", namespace: NAMESPACE, labels: grafanaLabels };
const grafanaFilesData = Object.fromEntries(Object.entries(files).map(([path, text]) => [keyOf(path), text]));
const grafanaFilesConfig = new ConfigMap({ metadata: grafanaFilesMeta, data: grafanaFilesData });

const grafanaContainer = {
  name: "grafana",
  image: GRAFANA_IMAGE,
  imagePullPolicy: "IfNotPresent",
  env: [
    { name: "GF_AUTH_ANONYMOUS_ENABLED", value: "true" },
    { name: "GF_AUTH_ANONYMOUS_ORG_ROLE", value: "Viewer" },
    { name: "GF_ANALYTICS_REPORTING_ENABLED", value: "false" },
    { name: "GF_ANALYTICS_CHECK_FOR_UPDATES", value: "false" },
    { name: "GF_PLUGINS_PREINSTALL_DISABLED", value: "true" },
  ],
  ports: [{ name: "http", containerPort: 3000 }],
  readinessProbe: { httpGet: { path: "/api/health", port: "http" }, initialDelaySeconds: 5, periodSeconds: 5 },
  livenessProbe: { tcpSocket: { port: "http" }, initialDelaySeconds: 30, periodSeconds: 10 },
  resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "1", memory: "512Mi" } },
  securityContext: {
    runAsNonRoot: true,
    runAsUser: 472,
    readOnlyRootFilesystem: true,
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
  },
  volumeMounts: [
    { name: "data", mountPath: "/var/lib/grafana" },
    { name: "tmp", mountPath: "/tmp" },
    { name: "provisioning", mountPath: PROVISIONING_PATH, readOnly: true },
    ...dashboardMounts,
  ],
};

const grafanaMeta = { name: "grafana", namespace: NAMESPACE, labels: grafanaLabels };
const grafanaSpec = {
  replicas: 1,
  selector: { matchLabels: grafanaSelector },
  template: {
    metadata: { labels: grafanaLabels },
    spec: {
      securityContext: { fsGroup: 472 },
      containers: [grafanaContainer],
      volumes: [
        { name: "data", emptyDir: {} },
        { name: "tmp", emptyDir: {} },
        { name: "provisioning", configMap: { name: "grafana-files", items: provisioningItems } },
        ...dashboardVolumes,
      ],
    },
  },
};
const grafana = new Deployment({ metadata: grafanaMeta, spec: grafanaSpec });

const grafanaServiceSpec = { selector: grafanaSelector, ports: [{ name: "http", port: 80, targetPort: "http" }] };
const grafanaService = new Service({ metadata: grafanaMeta, spec: grafanaServiceSpec });

export { grafanaFilesConfig, grafana, grafanaService };
