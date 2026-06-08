// Layered configuration — one composite, many environments, no new mechanism.
//
// A base config is overridden per environment with plain TypeScript object
// spread. The nested `labels` object is deep-merged with native nested spread
// (`...base.labels`). Everything is static const-to-const data, so it resolves
// at synthesis — chant's evaluability rules (EVL) permit const spread and
// static member-access spread; only a `deepMerge()` *function call* or a
// computed `config[key]` access would be rejected.
//
// This is the whole of "layered config": presets are the single-level case;
// this is the multi-level generalization, in the language you already have.
import type { WebAppProps } from "@intentius/chant-lexicon-k8s";

// ── Layer 1: base — every environment starts here ──────────────────────────
// Note: no `name` — each environment supplies its own so resources stay
// distinct and collision-free in a single build.
const base = {
  image: "ghcr.io/acme/web:1.4.0",
  port: 8080,
  replicas: 2,
  cpuRequest: "100m",
  cpuLimit: "250m",
  memoryRequest: "128Mi",
  memoryLimit: "256Mi",
  // A base-only nested object — every environment inherits it unchanged, so it
  // is set once here. (Not every nested layer needs a per-env override.)
  securityContext: {
    runAsNonRoot: true,
    runAsUser: 1000,
    readOnlyRootFilesystem: true,
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
  },
  // A nested object that DOES vary per environment — deep-merged below.
  labels: {
    "app.kubernetes.io/part-of": "acme-web",
    "app.kubernetes.io/managed-by": "chant",
  },
};

// ── Layer 2: per-environment overrides, spread over the base ───────────────
// `...base` shallow-merges the top level; `...base.labels` deep-merges the one
// nested object. Override only what differs; everything else inherits.

export const dev: WebAppProps = {
  ...base,
  name: "web-dev",
  // dev keeps base replicas/resources; no ingress.
  labels: { ...base.labels, "acme.io/env": "dev" },
};

export const staging: WebAppProps = {
  ...base,
  name: "web-staging",
  replicas: 3,
  cpuLimit: "500m",
  memoryLimit: "512Mi",
  ingressHost: "staging.acme.example",
  minAvailable: 1,
  labels: { ...base.labels, "acme.io/env": "staging" },
};

export const prod: WebAppProps = {
  ...base,
  name: "web-prod",
  replicas: 6,
  cpuRequest: "250m",
  cpuLimit: "1",
  memoryRequest: "256Mi",
  memoryLimit: "1Gi",
  ingressHost: "acme.example",
  minAvailable: 2,
  // Deep-merge: keep the base labels, add prod-only ones.
  labels: { ...base.labels, "acme.io/env": "prod", "acme.io/tier": "critical" },
};
