/**
 * Grafana as a plain Deployment, provisioned from ConfigMaps the grafana
 * lexicon writes. `GrafanaConfigMaps` puts each dashboard in a ConfigMap of
 * its own, labelled `grafana_dashboard: "1"` with its folder in the
 * `k8s-sidecar-target-directory` annotation, and the datasource and
 * dashboard-provider files in two more. A Grafana installed with the Helm
 * chart's sidecar would pick the labelled ones up as they are. This one has
 * no sidecar, so `grafanaVolumes()` mounts the same ConfigMaps where Grafana
 * reads provisioning files and dashboards.
 *
 * Anonymous viewers are let in so the dashboards open without a login on a
 * laptop cluster, and Grafana installs no plugins at startup.
 */
import { Deployment, Service } from "@intentius/chant-lexicon-k8s";
import { GrafanaConfigMaps, grafanaVolumes } from "@intentius/chant-lexicon-grafana/k8s";
import { prometheusDatasource, tempoDatasource, lokiDatasource } from "./datasources";
import { services, agentSlo, agentCalls } from "./dashboards";
import { NAMESPACE } from "./namespace";

export const GRAFANA_IMAGE = "grafana/grafana:12.4.11";

const grafanaLabels = { "app.kubernetes.io/name": "grafana", "app.kubernetes.io/component": "dashboards" };
const grafanaSelector = { "app.kubernetes.io/name": "grafana" };

const delivered = {
  entities: [prometheusDatasource, tempoDatasource, lokiDatasource, services.dashboard, agentSlo.dashboard, agentCalls.dashboard],
  labels: grafanaLabels,
};
const grafanaConfigMaps = GrafanaConfigMaps({ ...delivered, namespace: NAMESPACE });
const { volumes, volumeMounts } = grafanaVolumes(delivered);

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
  volumeMounts: [{ name: "data", mountPath: "/var/lib/grafana" }, { name: "tmp", mountPath: "/tmp" }, ...volumeMounts],
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
      volumes: [{ name: "data", emptyDir: {} }, { name: "tmp", emptyDir: {} }, ...volumes],
    },
  },
};
const grafana = new Deployment({ metadata: grafanaMeta, spec: grafanaSpec });

const grafanaServiceSpec = { selector: grafanaSelector, ports: [{ name: "http", port: 80, targetPort: "http" }] };
const grafanaService = new Service({ metadata: grafanaMeta, spec: grafanaServiceSpec });

export { grafanaConfigMaps, grafana, grafanaService };
