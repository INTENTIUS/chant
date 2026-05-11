/**
 * HelmRender example — install the External Secrets Operator from its
 * upstream chart at chant build time.
 *
 * What happens when you run `chant build src/`:
 * 1. chant evaluates this file (synchronously).
 * 2. The HelmRender composite shells out to `helm template`, fetching
 *    `external-secrets@0.10.4` from charts.external-secrets.io.
 * 3. The rendered manifests are cached under `~/.chant/helm-renders/<hash>/`.
 * 4. Each rendered K8s resource (Deployment, Service, ServiceAccount,
 *    CRDs, etc.) becomes a Declarable in the chant output — they appear
 *    in `dist/main.yaml` alongside whatever else you declare in this
 *    project.
 *
 * Requirements:
 * - The `helm` CLI must be on PATH at synth time.
 * - The chart repo must be reachable on first synth; cached afterwards.
 */

import { HelmRender } from "@intentius/chant-lexicon-helm";

export const externalSecrets = HelmRender({
  name: "external-secrets",
  repo: "https://charts.external-secrets.io",
  chart: "external-secrets",
  version: "0.10.4",
  namespace: "external-secrets",
  createNamespace: true,
  values: {
    installCRDs: true,
    webhook: { replicaCount: 1 },
  },
});
