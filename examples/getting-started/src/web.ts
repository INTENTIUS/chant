// L1 — the synthesis core.
//
// Typed Kubernetes resources in, plain Kubernetes YAML out. `chant build` reads
// the objects exported here and serializes them. It never talks to a cluster,
// reads state, or applies anything. Same source always produces the same YAML.
import { WebApp } from "@intentius/chant-lexicon-k8s";
import { appName, image } from "./config";

// WebApp is a composite — one typed call that expands to several wired resources
// (a Deployment, a Service, a PodDisruptionBudget). It carries the production
// defaults chant's lint expects, so the output is correct without hand-writing
// every field. Composites are the main way you compose infrastructure in chant.
const web = WebApp({
  name: appName,
  image,
  port: 8080,
  replicas: 2,
  minAvailable: 1,
  cpuRequest: "50m",
  memoryRequest: "64Mi",
  cpuLimit: "200m",
  memoryLimit: "128Mi",
  securityContext: {
    runAsNonRoot: true,
    runAsUser: 101,
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
  },
});

// Export the resources the composite produced. They are referenceable — later
// levels operate on these same declarations rather than redeclaring them.
export const deployment = web.deployment;
export const service = web.service;
export const pdb = web.pdb!;
