/**
 * The demo agent (app/agent.ts) as a Deployment in its own namespace,
 * sending OTLP/HTTP to the collector agent's Service. The image is built
 * locally and imported into the cluster (`npm run image`, then
 * `k3d image import`), so nothing is pulled from a registry.
 */
import { Deployment, NamespaceEnv } from "@intentius/chant-lexicon-k8s";
import { NAMESPACE } from "./namespace";

export const DEMO_IMAGE = "agent-observability-demo:0.1.0";
export const DEMO_NAMESPACE = "agents";

const agentsNamespace = NamespaceEnv({
  name: DEMO_NAMESPACE,
  defaultDenyIngress: true,
  labels: { "app.kubernetes.io/part-of": "agent-observability" },
});

const demoLabels = { "app.kubernetes.io/name": "support-agent", "app.kubernetes.io/component": "agent" };
const demoSelector = { "app.kubernetes.io/name": "support-agent" };

const demoContainer = {
  name: "agent",
  image: DEMO_IMAGE,
  imagePullPolicy: "IfNotPresent",
  env: [
    { name: "OTLP_ENDPOINT", value: `http://otel-agent.${NAMESPACE}.svc:4318` },
    { name: "INTERVAL_MS", value: "2000" },
  ],
  resources: { requests: { cpu: "20m", memory: "64Mi" }, limits: { cpu: "200m", memory: "128Mi" } },
  securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
};

const demoMeta = { name: "support-agent", namespace: DEMO_NAMESPACE, labels: demoLabels };
const demoSpec = {
  replicas: 1,
  selector: { matchLabels: demoSelector },
  template: {
    metadata: { labels: demoLabels },
    spec: {
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000 },
      containers: [demoContainer],
    },
  },
};
const supportAgent = new Deployment({ metadata: demoMeta, spec: demoSpec });

export { agentsNamespace, supportAgent };
