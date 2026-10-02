/**
 * Prometheus and Alertmanager as plain Kubernetes workloads, no operator and
 * no Helm. Each reads its config from a ConfigMap holding the files this
 * build root's prometheus entities serialize to, rendered with the same
 * `ruleFileYaml` / `alertmanagerYaml` the serializer uses, so the cluster
 * runs exactly what `chant build` writes.
 *
 * The images' default commands read /etc/prometheus/prometheus.yml and
 * /etc/alertmanager/alertmanager.yml, which is where the ConfigMaps mount.
 */
import { ConfiguredApp, type ConfiguredAppProps } from "@intentius/chant-lexicon-k8s";
import { alertmanagerYaml, ruleFileYaml } from "@intentius/chant-lexicon-prometheus";
import { stack } from "./rules";
import { root } from "./alertmanager";

export const PROMETHEUS_IMAGE = "prom/prometheus:v3.15.0";
export const ALERTMANAGER_IMAGE = "prom/alertmanager:v0.34.1";

const prometheusYml = `global:
  scrape_interval: 5s
  evaluation_interval: 5s
rule_files:
  - /etc/prometheus/rules.yml
alerting:
  alertmanagers:
    - static_configs:
        - targets: ["alertmanager:80"]
scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ["localhost:9090"]
  - job_name: alertmanager
    static_configs:
      - targets: ["alertmanager:80"]
`;

/** Both images run as nobody (65534) and need no capabilities. */
const securityContext: ConfiguredAppProps["securityContext"] = {
  runAsNonRoot: true,
  runAsUser: 65534,
  allowPrivilegeEscalation: false,
  capabilities: { drop: ["ALL"] },
};

const prometheus = ConfiguredApp({
  name: "prometheus",
  image: PROMETHEUS_IMAGE,
  port: 9090,
  replicas: 1,
  configData: { "prometheus.yml": prometheusYml, "rules.yml": ruleFileYaml([stack]) },
  configMountPath: "/etc/prometheus",
  securityContext,
});

const alertmanager = ConfiguredApp({
  name: "alertmanager",
  image: ALERTMANAGER_IMAGE,
  port: 9093,
  replicas: 1,
  configData: { "alertmanager.yml": alertmanagerYaml([root]) },
  configMountPath: "/etc/alertmanager",
  securityContext,
});

export { prometheus, alertmanager };
