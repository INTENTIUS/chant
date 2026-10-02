/**
 * Loki as one single-binary pod with filesystem storage on an emptyDir. It
 * takes the gateway's logs on its OTLP endpoint (`/otlp/v1/logs`), which
 * needs structured metadata on, and answers queries on 3100.
 */
import { ConfigMap, Deployment, Service } from "@intentius/chant-lexicon-k8s";
import { NAMESPACE } from "./namespace";

export const LOKI_IMAGE = "grafana/loki:3.6.0";

const lokiYaml = `auth_enabled: false
server:
  http_listen_port: 3100
  grpc_listen_port: 9096
common:
  instance_addr: 127.0.0.1
  path_prefix: /loki
  storage:
    filesystem:
      chunks_directory: /loki/chunks
      rules_directory: /loki/rules
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory
schema_config:
  configs:
    - from: 2024-01-01
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h
limits_config:
  allow_structured_metadata: true
analytics:
  reporting_enabled: false
`;

const lokiLabels = { "app.kubernetes.io/name": "loki", "app.kubernetes.io/component": "logs" };
const lokiSelector = { "app.kubernetes.io/name": "loki" };

const lokiConfigMeta = { name: "loki-config", namespace: NAMESPACE, labels: lokiLabels };
const lokiConfigData = { "loki.yaml": lokiYaml };
const lokiConfig = new ConfigMap({ metadata: lokiConfigMeta, data: lokiConfigData });

const lokiContainer = {
  name: "loki",
  image: LOKI_IMAGE,
  imagePullPolicy: "IfNotPresent",
  args: ["-config.file=/etc/loki/loki.yaml"],
  ports: [{ name: "http", containerPort: 3100 }],
  readinessProbe: { httpGet: { path: "/ready", port: "http" }, initialDelaySeconds: 15, periodSeconds: 5 },
  livenessProbe: { tcpSocket: { port: "http" }, initialDelaySeconds: 30, periodSeconds: 10 },
  resources: { requests: { cpu: "100m", memory: "256Mi" }, limits: { cpu: "1", memory: "1Gi" } },
  securityContext: {
    runAsNonRoot: true,
    runAsUser: 10001,
    readOnlyRootFilesystem: true,
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
  },
  volumeMounts: [
    { name: "config", mountPath: "/etc/loki", readOnly: true },
    { name: "data", mountPath: "/loki" },
    { name: "tmp", mountPath: "/tmp" },
  ],
};

const lokiMeta = { name: "loki", namespace: NAMESPACE, labels: lokiLabels };
const lokiSpec = {
  replicas: 1,
  selector: { matchLabels: lokiSelector },
  template: {
    metadata: { labels: lokiLabels },
    spec: {
      securityContext: { fsGroup: 10001 },
      containers: [lokiContainer],
      volumes: [
        { name: "config", configMap: { name: "loki-config" } },
        { name: "data", emptyDir: {} },
        { name: "tmp", emptyDir: {} },
      ],
    },
  },
};
const loki = new Deployment({ metadata: lokiMeta, spec: lokiSpec });

const lokiServiceSpec = { selector: lokiSelector, ports: [{ name: "http", port: 3100, targetPort: "http" }] };
const lokiService = new Service({ metadata: lokiMeta, spec: lokiServiceSpec });

export { lokiConfig, loki, lokiService };
