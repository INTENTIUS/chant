/**
 * Grafana as a plain Deployment, provisioned from the files this build
 * root's grafana entities render to. `grafanaFiles()` returns exactly what
 * `chant build --lexicon grafana` writes: the datasource and dashboard
 * provisioning files, and one JSON file per dashboard. They go into one
 * ConfigMap (keys cannot hold a `/`, so each path's slashes become `__`),
 * mounted twice with `items` putting each file back at its path: the
 * provisioning files under /etc/grafana/provisioning, the dashboards under
 * /var/lib/grafana/dashboards, where the provisioned provider reads them.
 *
 * Anonymous viewers are let in so the dashboards open without a login on a
 * laptop cluster.
 */
import { ConfigMap, Deployment, Service } from "@intentius/chant-lexicon-k8s";
import { grafanaFiles } from "@intentius/chant-lexicon-grafana";
import { prometheusDatasource, tempoDatasource, lokiDatasource } from "./datasources";
import { NAMESPACE } from "./namespace";

export const GRAFANA_IMAGE = "grafana/grafana:12.4.11";

const files = grafanaFiles([prometheusDatasource, tempoDatasource, lokiDatasource]);
const keyOf = (path: string): string => path.replaceAll("/", "__");
const under = (prefix: string) =>
  Object.keys(files)
    .filter((path) => path.startsWith(prefix))
    .map((path) => ({ key: keyOf(path), path: path.slice(prefix.length) }));

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
    { name: "provisioning", mountPath: "/etc/grafana/provisioning", readOnly: true },
    { name: "dashboards", mountPath: "/var/lib/grafana/dashboards", readOnly: true },
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
        { name: "provisioning", configMap: { name: "grafana-files", items: under("provisioning/") } },
        { name: "dashboards", configMap: { name: "grafana-files", items: under("dashboards/") } },
      ],
    },
  },
};
const grafana = new Deployment({ metadata: grafanaMeta, spec: grafanaSpec });

const grafanaServiceSpec = { selector: grafanaSelector, ports: [{ name: "http", port: 80, targetPort: "http" }] };
const grafanaService = new Service({ metadata: grafanaMeta, spec: grafanaServiceSpec });

export { grafanaFilesConfig, grafana, grafanaService };
