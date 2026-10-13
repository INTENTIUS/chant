// A small composite: one call expands to a Deployment and a Service.
//
// The factory body is a list of `const`s and a `return`, which is what lets
// `chant build` read it instead of running it. Because the body is read, the
// build knows that the Deployment's `spec.replicas` came from the `replicas`
// argument and that its container port came from `port`, and it records the
// line each argument was written on at the call.
import { Composite } from "@intentius/chant";
import { Deployment, Service } from "@intentius/chant-lexicon-k8s";

export interface WebAppProps {
  /** Name of the Deployment and Service, and the value of their name label. */
  name: string;
  /** Container image, pinned to a tag. */
  image: string;
  /** Number of pods the Deployment runs. */
  replicas: number;
  /** Port the container listens on. The Service forwards port 80 to it. */
  port: number;
}

export const WebApp = Composite((props: WebAppProps) => {
  const labels = { "app.kubernetes.io/name": props.name };
  const deployment = new Deployment({
    metadata: { name: props.name, labels },
    spec: {
      replicas: props.replicas,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          containers: [
            {
              name: "app",
              image: props.image,
              ports: [{ containerPort: props.port, name: "http" }],
              resources: {
                requests: { cpu: "10m", memory: "16Mi" },
                limits: { cpu: "100m", memory: "64Mi" },
              },
              readinessProbe: { httpGet: { path: "/", port: props.port } },
              livenessProbe: { httpGet: { path: "/", port: props.port } },
              imagePullPolicy: "IfNotPresent",
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 101,
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
              },
            },
          ],
        },
      },
    },
  });
  const service = new Service({
    metadata: { name: props.name, labels },
    spec: {
      selector: labels,
      ports: [{ name: "http", port: 80, targetPort: props.port }],
    },
  });
  return { deployment, service };
}, "WebApp");
