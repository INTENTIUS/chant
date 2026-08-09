// The platform layer — everything the apps depend on.
//
// This is plain Chant-authored k8s; it knows nothing about Flux. `npm run
// build:platform` renders it to dist/platform/, which you commit to the repo
// Flux watches. The `platform` Kustomization (src/flux) reconciles it, and
// both app Kustomizations declare `dependsOn: ["platform"]` so nothing lands
// before the namespace and issuer exist.

import { Namespace, ClusterIssuer } from "@intentius/chant-lexicon-k8s";
import { config } from "../config";

// The namespace both apps deploy into.
export const namespace = new Namespace({
  metadata: {
    name: config.appNamespace,
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
});

// A self-signed ClusterIssuer so the web app's Certificate needs no external
// CA — the homelab on-ramp. Swap for an ACME issuer when the cluster has a
// real domain.
export const issuer = new ClusterIssuer({
  metadata: {
    name: config.issuerName,
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  spec: {
    selfSigned: {},
  },
});
