/**
 * Tempo as one single-binary pod with local storage on an emptyDir: enough
 * for a laptop cluster, and gone with the pod. It takes the gateway's sampled
 * traces over OTLP gRPC on 4317 and answers queries on 3200.
 *
 * A plain Deployment rather than a `ConfiguredApp`, which has no way to add
 * the data volume or pass Tempo its `-config.file` argument.
 */
import { ConfigMap, Deployment, Service } from "@intentius/chant-lexicon-k8s";
import { NAMESPACE } from "./namespace";

export const TEMPO_IMAGE = "grafana/tempo:2.9.0";

const tempoYaml = `stream_over_http_enabled: true
server:
  http_listen_port: 3200
distributor:
  receivers:
    otlp:
      protocols:
        grpc:
          endpoint: 0.0.0.0:4317
ingester:
  max_block_duration: 5m
compactor:
  compaction:
    block_retention: 24h
storage:
  trace:
    backend: local
    wal:
      path: /var/tempo/wal
    local:
      path: /var/tempo/blocks
usage_report:
  reporting_enabled: false
`;

const tempoLabels = { "app.kubernetes.io/name": "tempo", "app.kubernetes.io/component": "traces" };
const tempoSelector = { "app.kubernetes.io/name": "tempo" };

const tempoConfigMeta = { name: "tempo-config", namespace: NAMESPACE, labels: tempoLabels };
const tempoConfigData = { "tempo.yaml": tempoYaml };
const tempoConfig = new ConfigMap({ metadata: tempoConfigMeta, data: tempoConfigData });

const tempoContainer = {
  name: "tempo",
  image: TEMPO_IMAGE,
  imagePullPolicy: "IfNotPresent",
  args: ["-config.file=/etc/tempo/tempo.yaml"],
  ports: [
    { name: "http", containerPort: 3200 },
    { name: "otlp-grpc", containerPort: 4317 },
  ],
  readinessProbe: { httpGet: { path: "/ready", port: "http" }, initialDelaySeconds: 10, periodSeconds: 5 },
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
    { name: "config", mountPath: "/etc/tempo", readOnly: true },
    { name: "data", mountPath: "/var/tempo" },
    { name: "tmp", mountPath: "/tmp" },
  ],
};

const tempoMeta = { name: "tempo", namespace: NAMESPACE, labels: tempoLabels };
const tempoSpec = {
  replicas: 1,
  selector: { matchLabels: tempoSelector },
  template: {
    metadata: { labels: tempoLabels },
    spec: {
      securityContext: { fsGroup: 10001 },
      containers: [tempoContainer],
      volumes: [
        { name: "config", configMap: { name: "tempo-config" } },
        { name: "data", emptyDir: {} },
        { name: "tmp", emptyDir: {} },
      ],
    },
  },
};
const tempo = new Deployment({ metadata: tempoMeta, spec: tempoSpec });

const tempoServiceSpec = {
  selector: tempoSelector,
  ports: [
    { name: "http", port: 3200, targetPort: "http" },
    { name: "otlp-grpc", port: 4317, targetPort: "otlp-grpc" },
  ],
};
const tempoService = new Service({ metadata: tempoMeta, spec: tempoServiceSpec });

export { tempoConfig, tempo, tempoService };
