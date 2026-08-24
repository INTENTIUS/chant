// The workload a PR gets a live copy of: one namespace, one web deployment,
// one service. Deliberately small — the point of the example is the loop
// around it, not the stack inside it.
//
// Every resource lands in the `preview-<env>` namespace and carries the
// ownership marker (`chant.intentius.io/stack: pr-preview` +
// `chant.intentius.io/env: <env>`, stamped by the build because
// `ownership.env` is bound to the env parameter). That marker is what
// `chant lifecycle teardown pr-<n> --yes` selects on when the PR closes.

import { Namespace, WebApp } from "@intentius/chant-lexicon-k8s";
import { config } from "./config";

const namespaceMetadata = { name: config.namespace };

export const namespace = new Namespace({
  metadata: namespaceMetadata,
});

const app = WebApp({
  name: config.appName,
  namespace: config.namespace,
  image: config.appImage,
  port: config.appPort,
  replicas: 1,
  cpuRequest: "50m",
  memoryRequest: "64Mi",
  cpuLimit: "200m",
  memoryLimit: "128Mi",
  securityContext: {
    // nginx-unprivileged runs as uid 101.
    runAsNonRoot: true,
    runAsUser: 101,
    readOnlyRootFilesystem: true,
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
  },
  labels: { "app.kubernetes.io/part-of": "github-pr-preview" },
});

export const { deployment, service } = app;
